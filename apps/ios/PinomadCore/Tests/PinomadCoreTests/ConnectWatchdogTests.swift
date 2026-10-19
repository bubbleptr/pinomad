import Foundation
import os
import Testing
@testable import PinomadCore

@Suite struct ConnectWatchdogTests {
    /// Callbacks land on the timer's executor, not the test's — count under
    /// a lock so the Sendable closure can mutate it.
    private final class Timeouts: @unchecked Sendable {
        private let count = OSAllocatedUnfairLock(initialState: 0)

        var value: Int { count.withLock { $0 } }
        func bump() { count.withLock { $0 += 1 } }
    }

    @Test func expiresAfterTheInjectedWindow() {
        let clock = TestClock()
        let timeouts = Timeouts()
        let watchdog = ConnectWatchdog(clock: clock, timeout: .seconds(3)) { timeouts.bump() }

        watchdog.begin()
        #expect(clock.delays == [.seconds(3)])
        #expect(watchdog.isRunning)

        clock.latest?.trigger()
        #expect(timeouts.value == 1)
        #expect(!watchdog.isRunning)
    }

    @Test func readyCancelsTheWindow() {
        let clock = TestClock()
        let timeouts = Timeouts()
        let watchdog = ConnectWatchdog(clock: clock) { timeouts.bump() }

        watchdog.begin()
        let handle = clock.latest
        watchdog.cancel()
        // Even a fire that raced past cancellation must be dropped.
        handle?.triggerAnyway()

        #expect(timeouts.value == 0)
        #expect(!watchdog.isRunning)
    }

    @Test func replacingTheAttemptDropsTheOldTimer() {
        let clock = TestClock()
        let timeouts = Timeouts()
        let watchdog = ConnectWatchdog(clock: clock) { timeouts.bump() }

        watchdog.begin()
        let old = clock.latest
        watchdog.begin()
        let current = clock.latest
        #expect(old !== current)

        old?.triggerAnyway()
        #expect(timeouts.value == 0)

        current?.trigger()
        #expect(timeouts.value == 1)
    }

    @Test func startedInBackgroundWaitsForForeground() {
        let clock = TestClock()
        let timeouts = Timeouts()
        let watchdog = ConnectWatchdog(clock: clock, timeout: .seconds(2)) { timeouts.bump() }

        // A session can start from an account-pairing response that lands
        // while the app is already in the background.
        watchdog.begin(paused: true)
        #expect(!watchdog.isRunning)
        #expect(clock.delays.isEmpty)

        watchdog.resume()
        #expect(clock.delays == [.seconds(2)])
        clock.latest?.trigger()
        #expect(timeouts.value == 1)
    }

    @Test func backgroundPausesAndForegroundRestartsTheFullWindow() {
        let clock = TestClock()
        let timeouts = Timeouts()
        let watchdog = ConnectWatchdog(clock: clock, timeout: .seconds(2)) { timeouts.bump() }

        watchdog.begin()
        let beforeBackground = clock.latest
        watchdog.pause()
        beforeBackground?.triggerAnyway()
        #expect(timeouts.value == 0)

        watchdog.resume()
        #expect(clock.delays == [.seconds(2), .seconds(2)])
        clock.latest?.trigger()
        #expect(timeouts.value == 1)
    }
}
