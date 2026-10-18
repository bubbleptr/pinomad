import Testing
@testable import PinomadChat
import PinomadCore

@Suite struct ConnectFailureTests {
    /// A 4401 means different things: for a pairing link the one-time code
    /// was refused (get a fresh link); for a stored host the device itself
    /// was rejected (forget it or pick another host).
    @Test func unauthorizedDependsOnWhetherThisWasAPairing() {
        #expect(ConnectFailure(outcome: .unauthorized, pairing: true) == .pairingRefused)
        #expect(ConnectFailure(outcome: .unauthorized, pairing: false) == .revoked)
    }

    @Test func mismatchSaysWhichSideToUpdate() {
        let older = ReadyOutcome.mismatch(hostMajor: 2, clientMajor: 1, direction: "client-older", hostVersion: "2.0.0")
        let newer = ReadyOutcome.mismatch(hostMajor: 1, clientMajor: 2, direction: "host-older", hostVersion: nil)
        #expect(ConnectFailure(outcome: older, pairing: false) == .appOutdated(hostMajor: 2, clientMajor: 1))
        #expect(ConnectFailure(outcome: newer, pairing: false) == .hostOutdated(hostMajor: 1, clientMajor: 2))
    }

    @Test func connectedIsNoFailure() {
        #expect(ConnectFailure(outcome: .connected, pairing: true) == nil)
        #expect(ConnectFailure(outcome: .error(message: "boom"), pairing: true) == .unreachable("boom"))
    }

    /// After the first view, a revoke (4401) or an outdated hello lands in
    /// the snapshot instead — the device is paired by then, so a 4401 is a
    /// revoke even if this session began as a pairing.
    @Test func aLiveSessionFailsFromItsSnapshot() {
        #expect(ConnectFailure(snapshot: snapshot(.connected)) == nil)
        #expect(ConnectFailure(snapshot: snapshot(.reconnecting)) == nil)
        #expect(ConnectFailure(snapshot: snapshot(.closed, unauthorized: true)) == .revoked)
        let mismatch = ProtocolMismatch(hostMajor: 3, clientMajor: 2, hostVersion: nil, direction: "client-older")
        #expect(ConnectFailure(snapshot: snapshot(.outdated, mismatch: mismatch)) == .appOutdated(hostMajor: 3, clientMajor: 2))
    }
}

private func snapshot(
    _ connection: ConnectionState, unauthorized: Bool = false, mismatch: ProtocolMismatch? = nil
) -> ClientSnapshot {
    ClientSnapshot(
        version: 1, connection: connection, unauthorized: unauthorized,
        protocolMismatch: mismatch, host: nil,
        organized: Organized(chats: [], projects: [], archived: []),
        notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
        conversation: nil)
}
