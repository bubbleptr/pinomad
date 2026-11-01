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
    case rtcPeerReady(peer: UInt64, sdp: String)
    case rtcChannelOpened(peer: UInt64)
    case rtcData(peer: UInt64, bytes: Data)
    case rtcSendResult(peer: UInt64, outcome: RtcSendOutcome)
    case rtcLowWater(peer: UInt64)
    case rtcClosed(peer: UInt64, reason: String?)
    case rtcSelectedCandidate(
        peer: UInt64, local: RtcSelectedCandidateEnd, remote: RtcSelectedCandidateEnd)
    /// An off-loop `snapshot()` finished — kept in queue order so the
    /// version check and dirty flag stay deterministic.
    case snapshotReady(ClientSnapshot?)
    /// Test seam: resumes once every earlier event was consumed.
    case barrier(CheckedContinuation<Void, Never>)
    /// Test seam: run a command batch through the real dispatch path —
    /// lets tests drive commands without a live host.
    case commands([FfiCommand])
    /// Test seam: register a request continuation the core never saw, so
    /// dispatch's failure classification can be driven by an
    /// `OperationFailed` command alone.
    case pendingRequest(op: UInt64, reply: CheckedContinuation<CallResult, any Error>)
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
    /// A validated hello endpoint set from a live connection, merged into
    /// the stored host (never resurrecting a forgotten one).
    case endpoints(HostRecord, saveError: String?)
    /// One candidate path failed; the round continues and the aggregate
    /// ready error carries the user-facing summary.
    case candidateFailed(CandidateFailure)
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
    public var rtcPlatform: any RtcPlatform
    /// Overrides `client.snapshot()` — lets tests drive the coalescing
    /// pump with synthetic versions instead of a connected core.
    var snapshotter: (@Sendable () -> ClientSnapshot?)?

    public init(
        socketFactory: any SessionSocketFactory,
        clock: any SessionClock,
        hostStore: any HostStore,
        rtcPlatform: any RtcPlatform = UnavailableRtcPlatform()
    ) {
        self.socketFactory = socketFactory
        self.clock = clock
        self.hostStore = hostStore
        self.rtcPlatform = rtcPlatform
    }

    public static var live: SessionDependencies {
        SessionDependencies(
            socketFactory: URLSessionSocketFactory(),
            clock: TaskClock(),
            hostStore: KeychainHostStore(),
            rtcPlatform: LiveRtcPlatform()
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
    /// The host every PerfLog line from this session is attributed to. A
    /// pairing learns it when the handshake completes.
    private var logHost: String?
    /// The in-memory identity this session is connected as. It survives a
    /// failed keychain write and is the source of truth for Retry's routing.
    private var currentHost: HostRecord?
    /// Whether the store is believed to hold `currentHost`. A paired host
    /// whose save failed is current but not stored; a stored host that a
    /// successful read no longer contains has been forgotten.
    private var currentHostInStore: Bool

    init(
        client: PinomadClient,
        dependencies: SessionDependencies,
        pairingAccount: AccountLink? = nil,
        host: HostRecord? = nil,
        hostIsStored: Bool = false,
        logHost: String? = nil
    ) {
        self.client = client
        self.dependencies = dependencies
        self.pairingAccount = pairingAccount
        self.currentHost = host
        self.currentHostInStore = hostIsStored
        self.logHost = logHost
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
        return PinomadSession(
            client: client,
            dependencies: dependencies,
            host: host,
            hostIsStored: true,
            logHost: host.hostKey)
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

    /// The conversation the core shows right now — read once a switch
    /// settles to tell whether it landed. A fresh snapshot, so it costs a
    /// compute: call it off the main actor.
    public var shownConversationNow: UInt64? {
        client.snapshot()?.conversation?.id
    }

    /// Request-class: the outcome and a host refusal both come back here,
    /// never as a notice. `target` is explicit so a conversation switch while
    /// the call is in flight cannot redirect it.
    public func withdrawQueued(submissionId: UInt64, target: UInt64) async throws -> WithdrawOutcome {
        let result = try await invoke(.withdrawQueued(submissionId: submissionId, target: target))
        guard case .withdrawQueued(let outcome) = result else {
            throw SessionError.operationFailed("The host's reply wasn't a withdraw result.")
        }
        return outcome
    }

    /// Request-class, like `withdrawQueued`.
    public func steerQueued(submissionId: UInt64, target: UInt64) async throws -> SteerOutcome {
        let result = try await invoke(.steerQueued(submissionId: submissionId, target: target))
        guard case .steerQueued(let outcome) = result else {
            throw SessionError.operationFailed("The host's reply wasn't a steer result.")
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
        if case .terminated = sink.yield(event) {
            switch event {
            case .invoke(_, _, let reply), .pendingRequest(_, let reply):
                reply.resume(throwing: SessionError.sessionClosed)
            default:
                break
            }
        }
    }

    /// The newest published snapshot version — tests only.
    var lastPublishedVersion: UInt64 { publishedVersion }

    /// What a request-class failure means. The core reports whether the
    /// carrier that actually took the call is gone; a retirement of any
    /// other connection (standby, signal-only, or an older generation) must
    /// not turn a live connection's refusal into a lost reply.
    static func requestFailure(carrierLost: Bool, message: String) -> SessionError {
        carrierLost ? .connectionLost : .operationFailed(message)
    }

    /// The connection-mode page's status. A pure read of the core, like
    /// `isConnectedNow`; safe from the main actor without touching the loop.
    public func rtcDiagnostics() -> RtcDiagnostics {
        client.rtcDiagnostics()
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
            case .invoke(_, _, let reply), .pendingRequest(_, let reply):
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
            signposter.emitEvent(
                "bytes", "\(self.logHost.map(PerfLog.hostSuffix) ?? "-", privacy: .public)")
            PerfLog.shared.mark("bytes", host: logHost)
            feed(.socketData(conn: conn, bytes: bytes))
        case .socketClosed(let conn, let code, let reason):
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
            feedClock()
            feed(.timerFired(timer: timer))
        case .invoke(let op, let call, let reply):
            if cancelledOps.remove(op) != nil {
                reply.resume(throwing: CancellationError())
            } else {
                pendingOps[op] = reply
                feed(.invoke(op: op, call: call))
            }
        case .abandonOp(let op):
            if let reply = pendingOps.removeValue(forKey: op) {
                reply.resume(throwing: CancellationError())
            } else {
                // The cancel beat the invoke — remember so it rejects
                // when it lands instead of running to completion.
                cancelledOps.insert(op)
            }
        case .foreground:
            feedClock()
            feed(.foreground)
        case .background:
            feedClock()
            feed(.background)
        case .networkChanged:
            // The socket's old candidates are dead on the new interface;
            // retiring the peers first lets the core fall back to the relay
            // before it decides what the change means.
            dependencies.rtcPlatform.networkChanged()
            feedClock()
            feed(.networkChanged)
        case .rtcPeerReady(let peer, let sdp):
            feedClock()
            feed(.rtcPeerReady(peer: peer, sdp: sdp))
        case .rtcChannelOpened(let peer):
            feedClock()
            feed(.rtcChannelOpened(peer: peer))
        case .rtcData(let peer, let bytes):
            feedClock()
            feed(.rtcData(peer: peer, bytes: bytes))
        case .rtcSendResult(let peer, let outcome):
            feedClock()
            feed(.rtcSendResult(peer: peer, outcome: outcome))
        case .rtcLowWater(let peer):
            feedClock()
            feed(.rtcLowWater(peer: peer))
        case .rtcClosed(let peer, let reason):
            feedClock()
            feed(.rtcClosed(peer: peer, reason: reason))
        case .rtcSelectedCandidate(let peer, let local, let remote):
            feedClock()
            feed(.rtcSelectedCandidate(peer: peer, local: local, remote: remote))
        case .snapshotReady(let snapshot):
            snapshotInFlight = false
            if let snapshot, snapshot.version > publishedVersion {
                publishedVersion = snapshot.version
                signposter.emitEvent(
                    "publish", "\(self.logHost.map(PerfLog.hostSuffix) ?? "-", privacy: .public)")
                PerfLog.shared.mark("publish", version: snapshot.version, host: logHost)
                updateSink.yield(.snapshot(snapshot))
            }
            if viewDirty { startSnapshot() }
        case .barrier(let reply):
            reply.resume()
        case .commands(let commands):
            dispatch(commands)
        case .pendingRequest(let op, let reply):
            pendingOps[op] = reply
        case .shutdown:
            dependencies.rtcPlatform.shutdown()
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
            cancelledOps.removeAll()
            shutdown = true
        }
    }

    /// Give the core the platform's monotonic clock. Decisions that depend
    /// on time (cooldowns, idle windows, stall timers) must see it before
    /// the event that asks the question.
    private func feedClock() {
        feed(.clock(nowMs: DispatchTime.now().uptimeNanoseconds / 1_000_000))
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
            case .scheduleReconnect(let timer, let delayMs),
                 .scheduleDeadline(let timer, let delayMs):
                timers[timer] = dependencies.clock.schedule(
                    delay: .milliseconds(delayMs),
                    fire: { [sink] in sink.yield(.timerFired(timer: timer)) }
                )
            case .cancelReconnect(let timer), .cancelDeadline(let timer):
                timers.removeValue(forKey: timer)?.cancel()
            case .ready(let outcome):
                updateSink.yield(.ready(outcome))
            case .viewChanged:
                viewDirty = true
                if !snapshotInFlight { startSnapshot() }
            case .candidateFailed(let failure):
                updateSink.yield(.candidateFailed(failure))
            case .paired(let host):
                persistPairing(host)
            case .endpointSet(let hostKey, let url, let endpointSet):
                mergeEndpoints(hostKey: hostKey, url: url, endpointSet: endpointSet)
            case .operationSucceeded(let op, let value):
                pendingOps.removeValue(forKey: op)?.resume(returning: value)
            case .operationFailed(let op, let error, let carrierLost):
                let failure = Self.requestFailure(carrierLost: carrierLost, message: error)
                pendingOps.removeValue(forKey: op)?.resume(throwing: failure)
            case .rtcSignalOnly(let hostKey, let signalOnly):
                persistSignalOnly(hostKey: hostKey, signalOnly: signalOnly)
            case .createRtcPeer(let peer, let stun):
                dependencies.rtcPlatform.createPeer(peer: peer, stun: stun) { [sink] event in
                    sink.yield(event)
                }
            case .acceptRtcAnswer(let peer, let sdp):
                dependencies.rtcPlatform.acceptAnswer(peer: peer, sdp: sdp)
            case .rtcSend(let peer, let bytes):
                dependencies.rtcPlatform.send(peer: peer, bytes: bytes)
            case .closeRtcPeer(let peer):
                dependencies.rtcPlatform.closePeer(peer: peer)
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
        let host = logHost.map(PerfLog.hostSuffix) ?? "-"
        Task { [sink] in
            let interval = signposter.beginInterval(
                "snapshot", id: .exclusive, "\(host, privacy: .public)")
            let t0 = ContinuousClock.now
            let snapshot = snapshotter()
            let elapsed = t0.duration(to: .now)
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            signposter.endInterval("snapshot", interval, "\(host, privacy: .public)")
            PerfLog.shared.measure("snapshot", ms: ms, version: snapshot?.version, host: logHost)
            sink.yield(.snapshotReady(snapshot))
        }
    }

    /// `Paired` is delivered inside dispatch, so the write happens
    /// synchronously and `.paired` reaches the app before `.ready` — a
    /// failed write rides along on it, never swallowed.
    private func persistPairing(_ host: StoredHost) {
        var record = HostRecord(
            url: host.url,
            hostKey: host.hostKey,
            privateKey: host.privateKey,
            name: host.name,
            account: host.account.map { AccountLink(serverOrigin: $0.serverOrigin, hostId: $0.hostId) },
            endpointSet: host.endpointSet.flatMap(StoredEndpointSet.init),
            connectionMode: host.connectionMode.flatMap(HostConnectionMode.init(rawValue:)),
            rtcSignalOnly: host.rtcSignalOnly,
            pairedAt: Date())
        var saveError: String?
        do {
            try dependencies.hostStore.update { stored in
                let existing = stored.hosts.first { $0.hostKey == host.hostKey }
                if record.name == nil { record.name = existing?.name }
                // A QR re-pair under a new key keeps the link, not the
                // account's vouch for the old key (#494).
                let kept = existing.flatMap { old in
                    old.privateKey == record.privateKey ? old.account : old.account?.unvouched
                }
                record.account = pairingAccount ?? kept ?? record.account
                if record.endpointSet == nil { record.endpointSet = existing?.endpointSet }
                if record.connectionMode == nil { record.connectionMode = existing?.connectionMode }
                if record.rtcSignalOnly == nil { record.rtcSignalOnly = existing?.rtcSignalOnly }
                stored.hosts.removeAll { $0.hostKey == host.hostKey }
                stored.hosts.append(record)
                stored.activeHostKey = host.hostKey
            }
        } catch {
            saveError = error.localizedDescription
        }
        // The host accepted this device even if the keychain did not. Keep
        // that identity as the session's routing source for learned endpoints.
        currentHost = record
        logHost = record.hostKey
        currentHostInStore = saveError == nil
        updateSink.yield(.paired(record, saveError: saveError))
    }

    /// Persist the learned signal-only hint through the store's serialized
    /// read-modify-write; the live identity is updated even when the host was
    /// never saved. A write failure is reported, never silently dropped.
    private func persistSignalOnly(hostKey: String, signalOnly: Bool) {
        if currentHost?.hostKey == hostKey {
            currentHost?.rtcSignalOnly = signalOnly
        }
        do {
            try dependencies.hostStore.update { stored in
                if let next = stored.settingSignalOnly(signalOnly, for: hostKey) {
                    stored = next
                }
            }
        } catch {
            updateSink.yield(.platformError(
                "Couldn't save this host's connection hint (\(error.localizedDescription))."))
        }
    }

    /// A validated hello set updates the live session's routing identity even
    /// when the keychain never held it (a paired save failure). Storage stays
    /// separate: a host proven forgotten is not resurrected.
    private func mergeEndpoints(hostKey: String, url: String, endpointSet: EndpointSet) {
        guard let set = StoredEndpointSet(endpointSet) else { return }
        var memory = currentHost
        if memory?.hostKey == hostKey {
            memory?.url = url
            memory?.endpointSet = set
            currentHost = memory
        }

        var stored: HostRecord?
        var saveError: String?
        do {
            try dependencies.hostStore.update { hosts in
                guard let next = hosts.settingEndpoints(set, url: url, for: hostKey) else { return }
                hosts = next
                stored = next.hosts.first { $0.hostKey == hostKey }
            }
            if stored != nil {
                currentHostInStore = true
            } else if currentHostInStore {
                // A successful read with no host proves it was forgotten.
                return
            }
        } catch {
            saveError = error.localizedDescription
            do {
                if let existing = try dependencies.hostStore
                    .load().hosts.first(where: { $0.hostKey == hostKey })
                {
                    currentHostInStore = true
                    stored = existing.applyingEndpoints(url: url, endpointSet: set)
                } else if currentHostInStore {
                    // Again: the host is gone, not a failed save.
                    return
                }
            } catch {
                // Neither the write nor the confirming read worked. The live
                // session still gets the new route; the warning says it was
                // not persisted.
                if let memory {
                    updateSink.yield(.endpoints(memory, saveError: saveError))
                } else {
                    updateSink.yield(.platformError(
                        "Couldn't save this host's updated addresses (\(saveError)); reading the keychain also failed (\(error.localizedDescription)). The connection is still live."))
                }
                return
            }
        }

        if let memory {
            updateSink.yield(.endpoints(memory, saveError: saveError))
        } else if let stored {
            updateSink.yield(.endpoints(stored, saveError: saveError))
        }
    }
}
