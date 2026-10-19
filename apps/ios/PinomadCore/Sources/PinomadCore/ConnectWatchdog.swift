import Foundation
import os

/// The first-connect deadline: one fresh window per connection attempt.
///
/// Every begin bumps a generation and cancels the old handle, and fire
/// checks that generation again — a timer whose cancellation raced with its
/// wake-up can never expire the attempt that replaced it. pause stops the
/// clock without ending the attempt; resume starts a full window again.
public final class ConnectWatchdog: @unchecked Sendable {
    public typealias TimeoutHandler = @Sendable () -> Void

    private struct State {
        var generation: UInt64 = 0
        var handle: (any SessionTimerHandle)?
        var active = false
        var paused = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let clock: any SessionClock
    private let timeout: Duration
    private let onTimeout: TimeoutHandler

    public init(
        clock: any SessionClock = TaskClock(),
        timeout: Duration = .seconds(15),
        onTimeout: @escaping TimeoutHandler
    ) {
        self.clock = clock
        self.timeout = timeout
        self.onTimeout = onTimeout
    }

    /// A connect is counting down right now.
    public var isRunning: Bool {
        state.withLock { $0.active && !$0.paused && $0.handle != nil }
    }

    /// Start a new attempt: a full window, invalidating any older one. A
    /// session can start while the app is already backgrounded, so begin
    /// paused in that case and let the foreground resume start the window.
    public func begin(paused: Bool = false) {
        let (token, old) = state.withLock { state -> (UInt64, (any SessionTimerHandle)?) in
            state.generation &+= 1
            state.active = true
            state.paused = paused
            let old = state.handle
            state.handle = nil
            return (state.generation, old)
        }
        old?.cancel()
        if !paused { arm(token) }
    }

    /// Ready, or any terminal failure: no timeout may fire from here.
    public func cancel() {
        let old = state.withLock { state -> (any SessionTimerHandle)? in
            state.generation &+= 1
            state.active = false
            state.paused = false
            let old = state.handle
            state.handle = nil
            return old
        }
        old?.cancel()
    }

    /// The app went to the background: stop the clock, keep the attempt.
    public func pause() {
        let old = state.withLock { state -> (any SessionTimerHandle)? in
            guard state.active, !state.paused else { return nil }
            state.generation &+= 1
            state.paused = true
            let old = state.handle
            state.handle = nil
            return old
        }
        old?.cancel()
    }

    /// Back in the foreground while still connecting: a fresh full window.
    public func resume() {
        let token = state.withLock { state -> UInt64? in
            guard state.active, state.paused else { return nil }
            state.generation &+= 1
            state.paused = false
            return state.generation
        }
        guard let token else { return }
        arm(token)
    }

    private func arm(_ token: UInt64) {
        let handle = clock.schedule(delay: timeout) { [weak self] in
            self?.fire(token)
        }
        let current = state.withLock { state -> Bool in
            guard state.active, !state.paused, state.generation == token else { return false }
            state.handle = handle
            return true
        }
        if !current { handle.cancel() }
    }

    private func fire(_ token: UInt64) {
        let expired = state.withLock { state -> Bool in
            guard state.active, !state.paused, state.generation == token else { return false }
            state.active = false
            state.handle = nil
            return true
        }
        if expired { onTimeout() }
    }
}
