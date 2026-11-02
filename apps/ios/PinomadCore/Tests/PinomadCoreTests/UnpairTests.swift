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
            forget: { await steps.add("forget answered=\($0)") })
        #expect(await steps.all == ["revoke", "forget answered=true"])
    }

    @Test func forgetsAnUnreachableHostHereOnly() async {
        let steps = Steps()
        await unpairHost(revoke: nil, forget: { await steps.add("forget answered=\($0)") })
        #expect(await steps.all == ["forget answered=false"])
    }

    /// The call can time out or the session can close under it; this end
    /// still goes, but the host may still hold this device (and its push
    /// registration), so the forget hears the host didn't answer.
    @Test(arguments: [SessionError.sessionClosed, SessionError.connectionLost])
    func forgetsHereWhenTheHostCallFails(error: SessionError) async {
        let steps = Steps()
        await unpairHost(
            revoke: { throw error },
            forget: { await steps.add("forget answered=\($0)") })
        #expect(await steps.all == ["forget answered=false"])
    }
}
