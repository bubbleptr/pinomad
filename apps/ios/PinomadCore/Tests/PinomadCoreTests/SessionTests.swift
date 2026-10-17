import Foundation
import os
import Testing
@testable import PinomadCore

/// The ordering contract — the reason the platform layer exists. Every
/// test is deterministic: socket deliveries and send completions are
/// driven by hand, and `waitForIdle` drains the queue instead of sleeping.
@Suite("Session ordering")
struct SessionOrderingTests {
    /// A spy on the exact order events cross into the core.
    private func recorder() -> (OSAllocatedUnfairLock<[FfiEvent]>, (FfiEvent) -> Void) {
        let seen = OSAllocatedUnfairLock(initialState: [FfiEvent]())
        return (seen, { event in seen.withLock { $0.append(event) } })
    }

    private func seenEvents(_ lock: OSAllocatedUnfairLock<[FfiEvent]>) -> [String] {
        lock.withLock { seen in
            seen.map { event in
                switch event {
                case .socketOpened(let c): "opened(\(c))"
                case .socketData(let c, _): "data(\(c))"
                case .socketClosed(let c, _, _): "closed(\(c))"
                case .sendFailed(let c): "sendFailed(\(c))"
                case .timerFired(let t): "timer(\(t))"
                case .invoke(let op, _): "invoke(\(op))"
                case .close: "close"
                case .foreground: "foreground"
                case .background: "background"
                case .networkChanged: "network"
                }
            }
        }
    }

    @Test func handshakeBytesGoOutOnOpen() async throws {
        let (session, factory, _, _) = try makeSession()
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))
        #expect(factory.openedURLs == ["ws://127.0.0.1:9999/"])

        socket.deliverOpened()
        await session.waitForIdle()
        await spinUntil({ socket.sent.count == 1 }, "handshake send")
        #expect(!socket.sent[0].isEmpty)
        session.close()
    }

    @Test func sendsAreFIFOPerConnection() async throws {
        let (session, factory, _, _) = try makeSession()
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))
        socket.policy = .hold

        // Three SendBytes land while the first write is still held:
        // only the head is ever in flight.
        session.enqueue(.commands([
            .sendBytes(conn: 1, bytes: Data([1])),
            .sendBytes(conn: 1, bytes: Data([2])),
            .sendBytes(conn: 1, bytes: Data([3])),
        ]))
        await session.waitForIdle()
        await spinUntil({ socket.calls.count == 1 }, "first send starts")
        #expect(socket.heldCount == 1)

        socket.releaseHeld()
        await session.waitForIdle()
        await spinUntil({ socket.calls.count == 2 }, "second send starts")
        #expect(socket.sent == [Data([1])])

        socket.releaseHeld()
        await session.waitForIdle()
        await spinUntil({ socket.calls.count == 3 }, "third send starts")
        socket.releaseHeld()
        await session.waitForIdle()

        #expect(socket.sent == [Data([1]), Data([2]), Data([3])])
        session.close()
    }

    @Test func eventsArriveInOrderWhileSendIsHeld() async throws {
        let (session, factory, _, _) = try makeSession()
        let (seen, hook) = recorder()
        session.handleHook = hook
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))

        // A write in flight does not block or reorder inbound events.
        socket.policy = .hold
        session.enqueue(.commands([.sendBytes(conn: 1, bytes: Data([9]))]))
        socket.deliverOpened()
        socket.deliverData(Data([0xDE, 0xAD]))
        await session.waitForIdle()

        #expect(seenEvents(seen) == ["opened(1)", "data(1)"])
        // The held send is still in flight — no SendFailed fabricated.
        session.close()
    }

    @Test func closeWhileSendHeldSwallowsTheLateCompletion() async throws {
        let (session, factory, _, _) = try makeSession()
        let (seen, hook) = recorder()
        session.handleHook = hook
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))

        socket.policy = .hold
        session.enqueue(.commands([.sendBytes(conn: 1, bytes: Data([9]))]))
        await session.waitForIdle()
        await spinUntil({ socket.calls.count == 1 }, "send in flight")

        session.enqueue(.commands([.closeSocket(conn: 1)]))
        await session.waitForIdle()
        #expect(socket.isClosed)

        // The write resolves after the conn is gone: dropped, never a
        // SendFailed into the core.
        socket.releaseHeld(fail: true)
        await session.waitForIdle()
        #expect(!seenEvents(seen).contains("sendFailed(1)"))
        session.close()
    }

    @Test func sendFailureReportsSendFailed() async throws {
        let (session, factory, _, _) = try makeSession()
        let (seen, hook) = recorder()
        session.handleHook = hook
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))

        socket.policy = .hold
        session.enqueue(.commands([.sendBytes(conn: 1, bytes: Data([9]))]))
        await session.waitForIdle()
        await spinUntil({ socket.calls.count == 1 }, "send in flight")

        socket.releaseHeld(fail: true)
        // The send task resumes off-queue — spin until its sendSettled
        // has crossed the loop, then the failure must have landed: the
        // core sees SendFailed and asks for the socket to be closed.
        await spinUntil(
            { self.seenEvents(seen).contains("sendFailed(1)") },
            "sendFailed reaches the core")
        #expect(socket.isClosed)
        session.close()
    }

    @Test func lateEventsFromADeadGenerationDoNotBleed() async throws {
        let (session, factory, _, _) = try makeSession()
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))

        socket.deliverOpened()
        await session.waitForIdle()
        await spinUntil({ socket.sent.count == 1 }, "handshake send")
        socket.deliverClosed(code: 1006)
        await session.waitForIdle()

        // Callbacks for the dead conn still reach the queue — the core
        // drops them by generation and nothing lands on the socket again.
        socket.deliverData(Data([0xBA, 0xD0]))
        socket.deliverOpened()
        socket.deliverClosed(code: 1000)
        await session.waitForIdle()
        #expect(socket.sent.count == 1)
        #expect(factory.sockets.count == 1)
        session.close()
    }

    @Test func cancelledTimerNeverFires() async throws {
        let (session, _, clock, _) = try makeSession()
        let (seen, hook) = recorder()
        session.handleHook = hook
        await session.waitForIdle()

        session.enqueue(.commands([.scheduleReconnect(timer: 3, delayMs: 5_000)]))
        await session.waitForIdle()
        session.enqueue(.commands([.cancelReconnect(timer: 3)]))
        await session.waitForIdle()
        // Even a fire that raced past cancellation is dropped — the core
        // must never see a TimerFired for a cancelled timer.
        clock.latest?.triggerAnyway()
        await session.waitForIdle()
        #expect(!seenEvents(seen).contains("timer(3)"))
        session.close()
    }

    @Test func armedTimerFiresOnce() async throws {
        let (session, _, clock, _) = try makeSession()
        let (seen, hook) = recorder()
        session.handleHook = hook
        await session.waitForIdle()

        session.enqueue(.commands([.scheduleReconnect(timer: 4, delayMs: 5_000)]))
        await session.waitForIdle()
        clock.latest?.trigger()
        clock.latest?.triggerAnyway() // a second fire must be dropped
        await session.waitForIdle()
        #expect(seenEvents(seen).filter { $0 == "timer(4)" }.count == 1)
        session.close()
    }

    @Test func networkEventBehindAnInvokeKeepsQueueOrder() async throws {
        let (session, factory, _, _) = try makeSession()
        let (seen, hook) = recorder()
        session.handleHook = hook
        await session.waitForIdle()
        let socket = try #require(factory.socket(conn: 1))
        socket.deliverOpened()
        await session.waitForIdle()

        // Capture the op's continuation first, then enqueue the invoke
        // and the socket event back-to-back on this thread — queue order
        // is deterministic by construction.
        let captured = OSAllocatedUnfairLock<CheckedContinuation<CallResult, any Error>?>(
            initialState: nil)
        let result = Task<CallResult, any Error> {
            try await withCheckedThrowingContinuation { reply in
                captured.withLock { $0 = reply }
            }
        }
        await spinUntil({ captured.withLock { $0 != nil } }, "reply captured")
        session.enqueue(.invoke(
            op: 9, call: .renameConversation(id: 1, title: "改名"),
            reply: captured.withLock { $0! }))
        socket.deliverData(Data([0x01]))
        await session.waitForIdle()

        #expect(seenEvents(seen) == ["opened(1)", "invoke(9)", "data(1)"])
        // Request-class while disconnected fails — the op resolves, not hangs.
        await #expect(throws: (any Error).self) { _ = try await result.value }
        session.close()
    }

    @Test func eventsQueuedBehindShutdownAreSettled() async throws {
        let (session, _, _, _) = try makeSession()
        await session.waitForIdle()

        // The invoke lands behind .shutdown: the stream is finished but
        // the buffered event still arrives — its waiter must be resumed
        // with sessionClosed instead of hanging.
        let captured = OSAllocatedUnfairLock<CheckedContinuation<CallResult, any Error>?>(
            initialState: nil)
        let result = Task<CallResult, any Error> {
            try await withCheckedThrowingContinuation { reply in
                captured.withLock { $0 = reply }
            }
        }
        await spinUntil({ captured.withLock { $0 != nil } }, "reply captured")
        session.close()
        session.enqueue(.invoke(
            op: 9, call: .renameConversation(id: 1, title: "x"),
            reply: captured.withLock { $0! }))
        await #expect(throws: SessionError.sessionClosed) { _ = try await result.value }
        // A barrier behind the shutdown also resolves instead of hanging.
        await session.waitForIdle()
    }

    @Test func invokeRejectsRequestClassCallsWhenDisconnected() async throws {
        let (session, _, _, _) = try makeSession()
        await session.waitForIdle()
        await #expect(throws: SessionError.self) {
            _ = try await session.invoke(.renameConversation(id: 1, title: "改名"))
        }
        session.close()
    }
}
