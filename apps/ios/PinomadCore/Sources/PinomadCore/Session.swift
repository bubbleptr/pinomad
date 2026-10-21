import Foundation
import os

/// Everything the single consumer loop sees, in queue order — wire
/// events, send completions, timers, UI calls, and internal bookkeeping.
/// One ordered stream is the ordering contract (ADR-0024 §3): encrypted
/// records that reach the core out of order permanently kill the channel.
/// Public because socket factories deliver into it; cases meant for the
/// loop itself are still only produced internally.
public enum SessionEvent: Sendable {
    case socketOpened(conn: UInt64)
    case socketData(conn: UInt64, bytes: Data)
    case socketClosed(conn: UInt64, code: UInt16, reason: String?)
    /// A `send` resolved; the loop translates a failure into `SendFailed`.
    case sendSettled(conn: UInt64, error: (any Error)?)
    case timerFired(timer: UInt64)
    case invoke(op: UInt64, call: FfiCall, reply: CheckedContinuation<CallResult, any Error>)
    /// The awaiting `invoke` was cancelled before its op completed.
    case abandonOp(op: UInt64)
    case foreground
    case background
    case networkChanged
    /// An off-loop `snapshot()` finished — kept in queue order so the
    /// version check and dirty flag stay deterministic.
    case snapshotReady(ClientSnapshot?)
    /// Test seam: resumes once every earlier event was consumed.
    case barrier(CheckedContinuation<Void, Never>)
    /// Test seam: run a command batch through the real dispatch path —
    /// lets tests drive commands without a live host.
    case commands([FfiCommand])
    /// UI asked to disconnect for good.
    case shutdown
}

/// What the session publishes for the UI, in arrival order.
public enum SessionUpdate: Sendable {
    /// First-view readiness — Connected or the reason it never will be.
    case ready(ReadyOutcome)
    /// The newest consistent view, monotonically versioned.
    case snapshot(ClientSnapshot)
    /// The pairing handshake finished and spent the link's one-time code:
    /// from here on this session is `host`'s device, before and whatever
    /// the first view says. `saveError` is why the keychain didn't keep it.
    case paired(HostRecord, saveError: String?)
    /// Platform-side failure the core cannot see (keychain, decoding).
    case platformError(String)
}

public enum SessionError: Error, Equatable {
    /// `OperationFailed` — request-class calls only. The connection that
    /// carried the request was still up, so this is the host's refusal.
    case operationFailed(String)
    /// The connection that carried a request closed while it was in flight.
    /// The host may or may not have applied it; the caller must re-confirm
    /// an idempotent request by id instead of treating this as a refusal.
    case connectionLost
    /// The op never completed because the session ended first.
    case sessionClosed
}

/// Injectable environment — tests swap every seam (socket, clock, store)
/// for deterministic fakes; nothing in the session sleeps or polls.
public struct SessionDependencies: Sendable {
    public var socketFactory: any SessionSocketFactory
    public var clock: any SessionClock
    public var hostStore: any HostStore
    /// Overrides `client.snapshot()` — lets tests drive the coalescing
    /// pump with synthetic versions instead of a connected core.
    var snapshotter: (@Sendable () -> ClientSnapshot?)?

    public init(
        socketFactory: any SessionSocketFactory,
        clock: any SessionClock,
        hostStore: any HostStore
    ) {
        self.socketFactory = socketFactory
        self.clock = clock
        self.hostStore = hostStore
    }

    public static var live: SessionDependencies {
        SessionDependencies(
            socketFactory: URLSessionSocketFactory(),
            clock: TaskClock(),
            hostStore: KeychainHostStore()
        )
    }
}

/// Drives one `PinomadClient`: every input lands in a single FIFO queue
/// that exactly one task drains, so `handle` and the dispatch of the
/// commands it returns happen inside one synchronous stretch — the core's
/// record order can never interleave with another `handle`.
///
/// `@unchecked Sendable`: the mutable state below is touched only inside
/// `run()`; every other entry point just yields into the stream.
public final class PinomadSession: @unchecked Sendable {
    private let client: PinomadClient
    private let dependencies: SessionDependencies
    private let sink: AsyncStream<SessionEvent>.Continuation
    private let events: AsyncStream<SessionEvent>
    private let updateSink: AsyncStream<SessionUpdate>.Continuation
    /// Single-consumer stream of UI-facing updates.
    public let updates: AsyncStream<SessionUpdate>
    /// Delivery latency instrumentation: `bytes` (wire data consumed),
    /// `snapshot` (one compute, begin/end), `publish` (a version reaching
    /// the UI). Recorded with Instruments' os_signpost template.
    private let signposter = OSSignposter(subsystem: "build.kieran.pinomad", category: "delivery")

    private let nextOp = OSAllocatedUnfairLock<UInt64>(initialState: 1)
    private var loopTask: Task<Void, Never>?

    // ── loop-owned state (only `run`, `process`, `dispatch` touch these) ──
    private struct ConnState {
        let socket: any SessionSocket
        var pending: [Data] = []
        var sending = false
    }
    private var conns: [UInt64: ConnState] = [:]
    private var timers: [UInt64: any SessionTimerHandle] = [:]
    private var pendingOps: [UInt64: CheckedContinuation<CallResult, any Error>] = [:]
    /// The connection epoch each pending request started on. A failure after
    /// the epoch moved cannot be told apart from a lost reply, even when a
    /// reconnect has already made the live state connected again.
    private var pendingOpGeneration: [UInt64: UInt64] = [:]
    private var connectionGeneration: UInt64 = 0
    /// Ops cancelled before their `invoke` even reached the queue — the
    /// cancel arrives first, so the invoke must reject on sight.
    private var cancelledOps: Set<UInt64> = []
    private var viewDirty = false
    private var snapshotInFlight = false
    private var publishedVersion: UInt64 = 0
    private var shutdown = false

    /// Test hook — observes the exact order events cross into the core.
    var handleHook: ((FfiEvent) -> Void)?

    /// The account this pairing is vouched through, written beside the
    /// stored host — nil for a QR/pasted pairing (which keeps any link the
    /// same host already had).
    private let pairingAccount: AccountLink?

    init(client: PinomadClient, dependencies: SessionDependencies, pairingAccount: AccountLink? = nil) {
        self.client = client
        self.dependencies = dependencies
        self.pairingAccount = pairingAccount
        var sink: AsyncStream<SessionEvent>.Continuation!
        self.events = AsyncStream { sink = $0 }
        self.sink = sink
        var updateSink: AsyncStream<SessionUpdate>.Continuation!
        self.updates = AsyncStream { updateSink = $0 }
        self.updateSink = updateSink
        self.loopTask = Task { await self.run() }
    }

    /// Pair a new device with a `pinomad://…#pair=…` link.
    public static func pair(
        link: String,
        deviceName: String,
        account: AccountLink? = nil,
        dependencies: SessionDependencies = .live
    ) throws -> PinomadSession {
        let client = try PinomadClient.pair(
            link: link, deviceName: deviceName, devicePrivateKey: nil)
        return PinomadSession(client: client, dependencies: dependencies, pairingAccount: account)
    }

    /// Reconnect to a stored host — the record is re-validated through
    /// `validateStoredHost` before it builds the channel.
    public static func connect(
        host: HostRecord,
        dependencies: SessionDependencies = .live
    ) throws -> PinomadSession {
        let validated = try validateStoredHost(host: host.ffi)
        let client = try PinomadClient.connect(host: validated)
        return PinomadSession(client: client, dependencies: dependencies)
    }

    // ── public inputs: all just yields into the one queue ──

    /// Run a controller call; resolves with its `CallResult` (or
    /// `SessionError.operationFailed` for request-class rejections, and
    /// `SessionError.connectionLost` when the connection carrying it closed
    /// before the answer arrived.
    public func invoke(_ call: FfiCall) async throws -> CallResult {
        let op = nextOp.withLock { value -> UInt64 in
            defer { value += 1 }
            return value
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { reply in
                // A closed session's stream is finished — resume here or
                // the caller hangs forever.
                if case .terminated = sink.yield(.invoke(op: op, call: call, reply: reply)) {
                    reply.resume(throwing: SessionError.sessionClosed)
                }
            }
        } onCancel: {
            sink.yield(.abandonOp(op: op))
        }
    }

    /// The shown conversation's queued input content, for Edit. A read of
    /// the core's current view under the client lock, like `snapshot()`, so
    /// it does not go through the event queue.
    public func queuedInput(submissionId: UInt64) -> QueuedInput? {
        client.queuedInput(submissionId: submissionId)
    }

    /// The core's connection state right now. This is only a gate for
    /// retrying an idempotent request — never evidence that an in-flight
    /// request was refused; its connection epoch decides that. A fresh
    /// snapshot is used because the published one may lag a reconnect.
    public var isConnectedNow: Bool {
        guard let snapshot = client.snapshot() else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    /// Request-class: the outcome and a host refusal both come back here,
    /// never as a notice. `target` is explicit so a conversation switch while
    /// the call is in flight cannot redirect it.
    public func withdrawQueued(submissionId: UInt64, target: UInt64) async throws -> WithdrawOutcome {
        let result = try await invoke(.withdrawQueued(submissionId: submissionId, target: target))
        guard case .withdrawQueued(let outcome) = result else {
            throw SessionError.operationFailed("宿主的回复不是撤回结果")
        }
        return outcome
    }

    /// Request-class, like `withdrawQueued`.
    public func steerQueued(submissionId: UInt64, target: UInt64) async throws -> SteerOutcome {
        let result = try await invoke(.steerQueued(submissionId: submissionId, target: target))
        guard case .steerQueued(let outcome) = result else {
            throw SessionError.operationFailed("宿主的回复不是引导结果")
        }
        return outcome
    }

    public func notifyForeground() { sink.yield(.foreground) }
    public func notifyBackground() { sink.yield(.background) }
    public func notifyNetworkChanged() { sink.yield(.networkChanged) }

    /// Disconnect and end the session — queued like everything else, so
    /// in-flight work lands before the socket dies.
    public func close() { sink.yield(.shutdown) }

    /// Wait until every queued event was consumed — tests only.
    /// A barrier that lands after the stream finished resumes at once
    /// (there is nothing left to wait for).
    func waitForIdle() async {
        await withCheckedContinuation { reply in
            if case .terminated = sink.yield(.barrier(reply)) {
                reply.resume()
            }
        }
    }

    /// Test seam: enqueue a raw event so commands/invokes can be driven
    /// through the real loop without a host. A terminated stream settles
    /// the invoke the same way `invoke()` does.
    func enqueue(_ event: SessionEvent) {
        if case .terminated = sink.yield(event),
           case .invoke(_, _, let reply) = event {
            reply.resume(throwing: SessionError.sessionClosed)
        }
    }

    /// The newest published snapshot version — tests only.
    var lastPublishedVersion: UInt64 { publishedVersion }

    /// What a request-class failure means, given the connection epoch the
    /// request started on and the current one. An untracked request keeps
    /// the old operation-failed behaviour; a moved epoch means the host may
    /// have applied the call before the reply was lost, so the caller must
    /// re-confirm by id instead of treating the error as a refusal.
    static func requestFailure(startedOn: UInt64?, current: UInt64, message: String) -> SessionError {
        guard let startedOn else { return .operationFailed(message) }
        return startedOn == current ? .operationFailed(message) : .connectionLost
    }

    // ── the loop ──

    private func run() async {
        dispatch(client.take())
        for await event in events {
            process(event)
        }
        updateSink.finish()
    }

    private func process(_ event: SessionEvent) {
        // Buffered events keep arriving after `finish()` — anything
        // queued behind .shutdown must still be settled, not dropped on
        // the floor with its waiter.
        if shutdown {
            switch event {
            case .invoke(_, _, let reply):
                reply.resume(throwing: SessionError.sessionClosed)
            case .barrier(let reply):
                reply.resume()
            default:
                break
            }
            return
        }
        switch event {
        case .socketOpened(let conn):
            feed(.socketOpened(conn: conn))
        case .socketData(let conn, let bytes):
            signposter.emitEvent("bytes")
            PerfLog.shared.mark("bytes")
            feed(.socketData(conn: conn, bytes: bytes))
        case .socketClosed(let conn, let code, let reason):
            // Bump before feeding: any request failed by this close must
            // know its connection epoch ended, even if a reconnect follows
            // before its caller resumes.
            if conns[conn] != nil { connectionGeneration &+= 1 }
            feed(.socketClosed(conn: conn, code: code, reason: reason))
            // A remote close is terminal for this generation but the
            // core does not echo CloseSocket back — clean up here or the
            // dead socket and its backlog live until shutdown.
            conns.removeValue(forKey: conn)?.socket.close()
        case .sendSettled(let conn, let error):
            guard var state = conns[conn] else { return }
            state.sending = false
            if error != nil {
                // The write is dead; drop the backlog and tell the core —
                // it emits CloseSocket and treats this as an abnormal close.
                state.pending.removeAll()
                conns[conn] = state
                connectionGeneration &+= 1
                feed(.sendFailed(conn: conn))
            } else {
                if !state.pending.isEmpty { state.pending.removeFirst() }
                conns[conn] = state
                pumpSend(conn: conn)
            }
        case .timerFired(let timer):
            // Armed check: a cancel already processed in this loop drops
            // the fire even if the task woke before its cancellation.
            guard timers.removeValue(forKey: timer) != nil else { return }
            feed(.timerFired(timer: timer))
        case .invoke(let op, let call, let reply):
            if cancelledOps.remove(op) != nil {
                reply.resume(throwing: CancellationError())
            } else {
                pendingOps[op] = reply
                pendingOpGeneration[op] = connectionGeneration
                feed(.invoke(op: op, call: call))
            }
        case .abandonOp(let op):
            pendingOpGeneration.removeValue(forKey: op)
            if let reply = pendingOps.removeValue(forKey: op) {
                reply.resume(throwing: CancellationError())
            } else {
                // The cancel beat the invoke — remember so it rejects
                // when it lands instead of running to completion.
                cancelledOps.insert(op)
            }
        case .foreground:
            feed(.foreground)
        case .background:
            feed(.background)
        case .networkChanged:
            feed(.networkChanged)
        case .snapshotReady(let snapshot):
            snapshotInFlight = false
            if let snapshot, snapshot.version > publishedVersion {
                publishedVersion = snapshot.version
                signposter.emitEvent("publish")
                PerfLog.shared.mark("publish", version: snapshot.version)
                updateSink.yield(.snapshot(snapshot))
            }
            if viewDirty { startSnapshot() }
        case .barrier(let reply):
            reply.resume()
        case .commands(let commands):
            dispatch(commands)
        case .shutdown:
            feed(.close)
            sink.finish()
            for (_, state) in conns { state.socket.close() }
            conns.removeAll()
            for (_, timer) in timers { timer.cancel() }
            timers.removeAll()
            // The core's close does not settle outstanding ops — a
            // waiting caller must not hang on a dead session.
            for (_, reply) in pendingOps {
                reply.resume(throwing: SessionError.sessionClosed)
            }
            pendingOps.removeAll()
            pendingOpGeneration.removeAll()
            cancelledOps.removeAll()
            shutdown = true
        }
    }

    /// `handle` into the core; dispatch of the returned commands is part
    /// of the same synchronous stretch — no suspension can interleave.
    private func feed(_ event: FfiEvent) {
        handleHook?(event)
        dispatch(client.handle(event: event))
    }

    /// Dispatching one batch is synchronous: every command is registered
    /// (sends queued, timers armed, ops resumed, sockets swapped) before
    /// the loop moves on — the ordering contract's other half.
    private func dispatch(_ commands: [FfiCommand]) {
        for command in commands {
            switch command {
            case .openConnection(let conn, let url):
                let socket = dependencies.socketFactory.open(url: url, conn: conn) { [sink] event in
                    sink.yield(event)
                }
                conns[conn] = ConnState(socket: socket)
            case .sendBytes(let conn, let bytes):
                guard conns[conn] != nil else { continue }
                conns[conn]?.pending.append(bytes)
                pumpSend(conn: conn)
            case .closeSocket(let conn):
                conns.removeValue(forKey: conn)?.socket.close()
            case .scheduleReconnect(let timer, let delayMs):
                timers[timer] = dependencies.clock.schedule(
                    delay: .milliseconds(delayMs),
                    fire: { [sink] in sink.yield(.timerFired(timer: timer)) }
                )
            case .cancelReconnect(let timer):
                timers.removeValue(forKey: timer)?.cancel()
            case .ready(let outcome):
                updateSink.yield(.ready(outcome))
            case .viewChanged:
                viewDirty = true
                if !snapshotInFlight { startSnapshot() }
            case .paired(let url, let hostKey, let privateKey):
                persistPairing(url: url, hostKey: hostKey, privateKey: privateKey)
            case .operationSucceeded(let op, let value):
                pendingOpGeneration.removeValue(forKey: op)
                pendingOps.removeValue(forKey: op)?.resume(returning: value)
            case .operationFailed(let op, let error):
                let started = pendingOpGeneration.removeValue(forKey: op)
                let failure = Self.requestFailure(
                    startedOn: started, current: connectionGeneration, message: error)
                pendingOps.removeValue(forKey: op)?.resume(throwing: failure)
            }
        }
    }

    /// Start the head of the FIFO if nothing is in flight. `send`
    /// completion arrives back here as `.sendSettled`, so at most one
    /// write per conn is ever on the wire — order is the queue's order.
    private func pumpSend(conn: UInt64) {
        guard var state = conns[conn], !state.sending, let bytes = state.pending.first else { return }
        state.sending = true
        conns[conn] = state
        let socket = state.socket
        Task { [sink] in
            let error: (any Error)?
            do {
                try await socket.send(bytes)
                error = nil
            } catch let caught {
                error = caught
            }
            sink.yield(.sendSettled(conn: conn, error: error))
        }
    }

    /// At most one `snapshot()` in flight; a `ViewChanged` during it sets
    /// `viewDirty`, and `.snapshotReady` re-triggers — the burst coalesces
    /// into one computation per settled round.
    private func startSnapshot() {
        viewDirty = false
        snapshotInFlight = true
        let snapshotter = dependencies.snapshotter ?? { [client] in client.snapshot() }
        let signposter = self.signposter
        Task { [sink] in
            let interval = signposter.beginInterval("snapshot")
            let t0 = ContinuousClock.now
            let snapshot = snapshotter()
            let elapsed = t0.duration(to: .now)
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            signposter.endInterval("snapshot", interval)
            PerfLog.shared.measure("snapshot", ms: ms, version: snapshot?.version)
            sink.yield(.snapshotReady(snapshot))
        }
    }

    /// `Paired` is delivered inside dispatch, so the write happens
    /// synchronously and `.paired` reaches the app before `.ready` — a
    /// failed write rides along on it, never swallowed.
    private func persistPairing(url: String, hostKey: String, privateKey: String) {
        var record = HostRecord(url: url, hostKey: hostKey, privateKey: privateKey, pairedAt: Date())
        do {
            try dependencies.hostStore.update { stored in
                record.account = pairingAccount ?? stored.hosts.first { $0.hostKey == hostKey }?.account
                stored.hosts.removeAll { $0.hostKey == hostKey }
                stored.hosts.append(record)
                stored.activeHostKey = hostKey
            }
            updateSink.yield(.paired(record, saveError: nil))
        } catch {
            updateSink.yield(.paired(record, saveError: error.localizedDescription))
        }
    }
}
