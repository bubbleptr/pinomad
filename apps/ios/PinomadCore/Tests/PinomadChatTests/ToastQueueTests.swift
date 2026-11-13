import Testing
@testable import PinomadChat

@Suite struct ToastQueueTests {
    @Test func aNewFailureOfTheSameActionReplacesTheOldOne() {
        var queue = ToastQueue()
        queue.show("Couldn't steer: busy", level: .error, key: "steer")
        queue.show("Couldn't reorder: gone", level: .error, key: "reorder")
        let second = queue.show("Couldn't steer: closed", level: .error, key: "steer")
        #expect(queue.toasts.map(\.message) == ["Couldn't reorder: gone", "Couldn't steer: closed"])
        #expect(queue.toasts.last?.id == second.id)
    }

    @Test func aRetryClearsItsActionsError() {
        var queue = ToastQueue()
        queue.show("Couldn't steer: busy", level: .error, key: "steer")
        queue.show("Host restarted", level: .info)
        queue.clear(key: "steer")
        #expect(queue.toasts.map(\.message) == ["Host restarted"])
    }

    @Test func unkeyedToastsStack() {
        var queue = ToastQueue()
        queue.show("a", level: .info)
        queue.show("a", level: .info)
        #expect(queue.toasts.count == 2)
    }

    /// An error waits for the reader; anything else goes on its own.
    @Test func onlyErrorsStay() {
        var queue = ToastQueue()
        #expect(queue.show("x", level: .error).sticky)
        #expect(!queue.show("x", level: .warning).sticky)
        #expect(!queue.show("x", level: .success).sticky)
        #expect(!queue.show("x", level: .info).sticky)
    }

    @Test func theOldestGoesPastTheLimit() {
        var queue = ToastQueue()
        for n in 0..<(ToastQueue.limit + 2) { queue.show("\(n)", level: .info) }
        #expect(queue.toasts.map(\.message) == (2..<(ToastQueue.limit + 2)).map { "\($0)" })
    }

    @Test func dismissRemovesOnlyThatToast() {
        var queue = ToastQueue()
        let first = queue.show("a", level: .error)
        queue.show("b", level: .error)
        queue.dismiss(first.id)
        #expect(queue.toasts.map(\.message) == ["b"])
    }

    @Test func hostLevelsMapAndUnknownIsInfo() {
        #expect(ToastLevel(host: "error") == .error)
        #expect(ToastLevel(host: "warning") == .warning)
        #expect(ToastLevel(host: "debug") == .info)
    }
}
