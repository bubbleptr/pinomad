import Foundation

/// A scheduled reconnect timer; `cancel` must prevent a later fire.
public protocol SessionTimerHandle: Sendable {
    func cancel()
}

/// Arms one-shot timers. The `fire` closure runs on whatever executor
/// the implementation chooses — it only yields into the session queue.
public protocol SessionClock: Sendable {
    func schedule(
        delay: Duration,
        fire: @escaping @Sendable () -> Void
    ) -> any SessionTimerHandle
}

/// Real timers: `Task.sleep`, cancelled by `CancelReconnect` or shutdown.
/// The session's armed-set is the second guard, so a task that woke
/// concurrently with its cancellation still can't fire.
public struct TaskClock: SessionClock {
    public init() {}

    public func schedule(
        delay: Duration,
        fire: @escaping @Sendable () -> Void
    ) -> any SessionTimerHandle {
        let task = Task {
            try? await Task.sleep(for: delay)
            if !Task.isCancelled { fire() }
        }
        return TaskHandle(task: task)
    }

    private struct TaskHandle: SessionTimerHandle {
        let task: Task<Void, Never>
        func cancel() { task.cancel() }
    }
}
