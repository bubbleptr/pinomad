import Testing
@testable import PinomadCore

/// After Confirm (#497) the app keeps asking for the account's hosts until
/// the confirmed one pairs: the host only joins after its next poll, a
/// service restart and whatever retries its network needs, and automatic
/// registration only runs on a refresh. Virtual time, no real sleeps.
@Suite("Host join watch")
@MainActor
struct HostJoinWatchTests {
    /// Not listed until ~30 s, listed offline, online at 40 s, when that
    /// round's refresh starts the automatic registration; the next round
    /// sees it paired and the watch stops there.
    @Test func pollsUntilTheConfirmedHostPairs() async {
        var now: Duration = .zero
        var polls: [Duration] = []
        var registered = false
        let outcome = await HostJoinWatch.run(
            sleep: { now += $0 },
            poll: {
                polls.append(now)
                if registered { return .paired }
                let listed = now >= .seconds(30)
                let online = now >= .seconds(40)
                if listed && online { registered = true }
                return .waiting
            })
        #expect(outcome == .paired)
        #expect(polls.first == .seconds(5))
        #expect(polls.last == .seconds(45))
        #expect(now == .seconds(45))
    }

    /// A host that never shows up stops the asking at two minutes.
    @Test func aHostThatNeverAppearsStopsAtTwoMinutes() async {
        var now: Duration = .zero
        var polls = 0
        let outcome = await HostJoinWatch.run(
            sleep: { now += $0 },
            poll: {
                polls += 1
                return .waiting
            })
        #expect(outcome == .timedOut)
        #expect(now == .seconds(120))
        #expect(polls == 24)
    }

    @Test func signingOutStopsIt() async {
        var now: Duration = .zero
        let outcome = await HostJoinWatch.run(
            sleep: { now += $0 },
            poll: { now >= .seconds(15) ? .signedOut : .waiting })
        #expect(outcome == .signedOut)
        #expect(now == .seconds(15))
    }

    /// Cancelled while waiting (a newer confirm, a sign-out): no more polls.
    @Test func cancellingStopsIt() async {
        var now: Duration = .zero
        var polls = 0
        let outcome = await HostJoinWatch.run(
            sleep: { duration in
                if now >= .seconds(10) { throw CancellationError() }
                now += duration
            },
            poll: {
                polls += 1
                return .waiting
            })
        #expect(outcome == .cancelled)
        #expect(polls == 2)
    }
}
