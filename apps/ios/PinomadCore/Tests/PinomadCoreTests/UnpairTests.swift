import Testing
@testable import PinomadCore

/// Unpairing ends the pairing at both ends when the host can be reached, and
/// always drops this device's half — the two halves must not drift apart.
@Suite struct UnpairTests {
    private actor Steps {
        var all: [String] = []
        func add(_ step: String) { all.append(step) }
    }

    @Test func asksTheHostToDropThisDeviceThenForgetsItHere() async {
        let steps = Steps()
        await unpairHost(
            revoke: { await steps.add("revoke") },
            forget: { await steps.add("forget") })
        #expect(await steps.all == ["revoke", "forget"])
    }

    @Test func forgetsAnUnreachableHostHereOnly() async {
        let steps = Steps()
        await unpairHost(revoke: nil, forget: { await steps.add("forget") })
        #expect(await steps.all == ["forget"])
    }

    /// The session can end under the call — the host closes a device that
    /// unpaired itself — or the call can time out; this end still goes.
    @Test func forgetsHereWhenTheHostCallFails() async {
        let steps = Steps()
        await unpairHost(
            revoke: { throw SessionError.sessionClosed },
            forget: { await steps.add("forget") })
        #expect(await steps.all == ["forget"])
    }
}
