import Foundation
import os
import Testing
@testable import PinomadCore

enum FakeError: Error {
    case sendFailed
    case storeBroken
}

/// A socket whose every side effect is test-driven: the test delivers
/// inbound events and decides when (or whether) each `send` completes —
/// no sleeps anywhere.
final class FakeSocket: SessionSocket, @unchecked Sendable {
    enum Policy {
        case succeed
        case hold
        case fail
    }

    private struct Held {
        let data: Data
        let reply: CheckedContinuation<Void, any Error>
    }

    private struct State {
        var policy = Policy.succeed
        var calls: [Data] = []
        var sent: [Data] = []
        var held: [Held] = []
        var closed = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    let conn: UInt64
    let url: String
    private let sink: @Sendable (SessionEvent) -> Void

    init(conn: UInt64, url: String, sink: @escaping @Sendable (SessionEvent) -> Void) {
        self.conn = conn
        self.url = url
        self.sink = sink
    }

    // ── test drives the socket's inbound side ──

    func deliverOpened() { sink(.socketOpened(conn: conn)) }
    func deliverData(_ bytes: Data) { sink(.socketData(conn: conn, bytes: bytes)) }
    func deliverClosed(code: UInt16, reason: String? = nil) {
        sink(.socketClosed(conn: conn, code: code, reason: reason))
    }

    // ── assertions ──

    var calls: [Data] { state.withLock { $0.calls } }
    var sent: [Data] { state.withLock { $0.sent } }
    var heldCount: Int { state.withLock { $0.held.count } }
    var isClosed: Bool { state.withLock { $0.closed } }
    var policy: Policy {
        get { state.withLock { $0.policy } }
        set { state.withLock { $0.policy = newValue } }
    }

    /// Complete every held send in FIFO order — succeeds by default.
    func releaseHeld(fail: Bool = false) {
        let held = state.withLock { s -> [Held] in
            defer { s.held.removeAll() }
            return s.held
        }
        for item in held {
            if fail {
                item.reply.resume(throwing: FakeError.sendFailed)
            } else {
                state.withLock { $0.sent.append(item.data) }
                item.reply.resume()
            }
        }
    }

    // ── SessionSocket ──

    func send(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { reply in
            enum Action { case ok, fail, held }
            let action = state.withLock { s -> Action in
                s.calls.append(data)
                switch s.policy {
                case .succeed:
                    s.sent.append(data)
                    return .ok
                case .fail:
                    return .fail
                case .hold:
                    s.held.append(Held(data: data, reply: reply))
                    return .held
                }
            }
            switch action {
            case .ok: reply.resume()
            case .fail: reply.resume(throwing: FakeError.sendFailed)
            case .held: break
            }
        }
    }

    func close() {
        state.withLock { $0.closed = true }
        // A dying socket fails whatever was still in flight — keeps fake
        // continuations from leaking the way a real task.send would.
        releaseHeld(fail: true)
    }
}

final class FakeSocketFactory: SessionSocketFactory, @unchecked Sendable {
    private let opened = OSAllocatedUnfairLock(initialState: [FakeSocket]())

    var sockets: [FakeSocket] { opened.withLock { $0 } }
    var openedURLs: [String] { sockets.map(\.url) }
    func socket(conn: UInt64) -> FakeSocket? { sockets.first { $0.conn == conn } }

    func open(
        url: String,
        conn: UInt64,
        sink: @escaping @Sendable (SessionEvent) -> Void
    ) -> any SessionSocket {
        let socket = FakeSocket(conn: conn, url: url, sink: sink)
        opened.withLock { $0.append(socket) }
        return socket
    }
}

/// A clock that never fires on its own — tests trigger handles directly.
final class TestClock: SessionClock, @unchecked Sendable {
    final class Handle: SessionTimerHandle {
        private let fired = OSAllocatedUnfairLock(initialState: false)
        private let _fire: @Sendable () -> Void
        init(fire: @escaping @Sendable () -> Void) { _fire = fire }

        func cancel() { fired.withLock { $0 = true } }
        /// A real timer never fires after cancel — the session's armed
        /// set is the other guard, tested by `triggerAnyway`.
        func trigger() { if !fired.withLock({ $0 }) { _fire() } }
        /// Simulates a fire that raced past its cancellation.
        func triggerAnyway() { _fire() }
    }

    private let scheduled = OSAllocatedUnfairLock(initialState: [Handle]())
    private let scheduledDelays = OSAllocatedUnfairLock(initialState: [Duration]())
    var all: [Handle] { scheduled.withLock { $0 } }
    var latest: Handle? { all.last }
    /// Every requested delay, in schedule order — lets a test assert the
    /// injected window rather than sleeping through it.
    var delays: [Duration] { scheduledDelays.withLock { $0 } }

    func schedule(
        delay: Duration,
        fire: @escaping @Sendable () -> Void
    ) -> any SessionTimerHandle {
        let handle = Handle(fire: fire)
        scheduledDelays.withLock { $0.append(delay) }
        scheduled.withLock { $0.append(handle) }
        return handle
    }
}

/// Host store with injectable failures.
final class StubHostStore: HostStore, @unchecked Sendable {
    var stored = StoredHosts()
    var loadError: (any Error)?
    var saveError: (any Error)?

    func load() throws -> StoredHosts {
        if let loadError { throw loadError }
        return stored
    }

    func save(_ hosts: StoredHosts) throws {
        if let saveError { throw saveError }
        stored = hosts
    }

    func update(_ body: (inout StoredHosts) throws -> Void) throws {
        if let loadError { throw loadError }
        var next = stored
        try body(&next)
        guard next != stored else { return }
        if let saveError { throw saveError }
        stored = next
    }
}

/// Reads `session.updates` without polling: `next` suspends until an
/// update arrives; the timeout keeps a broken expectation from hanging
/// the suite forever.
final class UpdateReader: @unchecked Sendable {
    private var iterator: AsyncStream<SessionUpdate>.Iterator

    init(_ session: PinomadSession) {
        iterator = session.updates.makeAsyncIterator()
    }

    func next() async -> SessionUpdate? { await iterator.next() }

    func next(timeout: Duration = .seconds(10)) async -> SessionUpdate? {
        await withTaskGroup(of: SessionUpdate?.self) { group in
            group.addTask { await self.next() }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

/// Cooperatively yield until a queued side task lands — bounded so a
/// broken expectation fails instead of hanging.
func spinUntil(
    _ predicate: @Sendable () -> Bool,
    _ label: String,
    maxYields: Int = 10_000
) async {
    for _ in 0..<maxYields where !predicate() {
        await Task.yield()
    }
    #expect(predicate(), "spin timed out: \(label)")
}

/// A `pinomad://` link that parses — 32 zero bytes host key, a short
/// secret, an unreachable socket URL (tests drive the socket by hand).
let testPairingLink =
    "pinomad://pair#pair=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AQID&url=ws%3A%2F%2F127.0.0.1%3A9999%2F"

func makeSession(
    socketFactory: FakeSocketFactory = FakeSocketFactory(),
    clock: TestClock = TestClock(),
    hostStore: StubHostStore = StubHostStore(),
    configure: (inout SessionDependencies) -> Void = { _ in }
) throws -> (PinomadSession, FakeSocketFactory, TestClock, StubHostStore) {
    var dependencies = SessionDependencies(
        socketFactory: socketFactory, clock: clock, hostStore: hostStore)
    configure(&dependencies)
    let client = try PinomadClient.pair(
        link: testPairingLink, deviceName: "测试 iPhone 📱", devicePrivateKey: nil)
    return (PinomadSession(client: client, dependencies: dependencies), socketFactory, clock, hostStore)
}
