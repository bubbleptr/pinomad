import PinomadCore
import Testing
@testable import PinomadChat

@Suite("Pairing persistence warning")
struct PairingWarningTests {
    private let host = HostRecord(
        url: "ws://127.0.0.1:7420/",
        hostKey: "host",
        privateKey: "key")

    @Test func warningSurvivesReadyErrorAndMismatch() {
        var state = PairingWarningState()
        state.apply(.paired(host, saveError: "keychain locked"))
        let warning = state.message
        #expect(warning?.contains("Couldn't save this host") == true)
        #expect(warning?.contains("keychain locked") == true)

        state.apply(.ready(.error(message: "Couldn't reach the host: relay failed")))
        #expect(state.message == warning)
        #expect(state.message?.contains("Couldn't reach") == false)

        state.apply(.ready(.mismatch(
            hostMajor: 6, clientMajor: 5, direction: "client-older", hostVersion: nil)))
        #expect(state.message == warning)
    }

    @Test func successfulSaveClearsAndNewSessionClears() {
        var state = PairingWarningState()
        state.apply(.paired(host, saveError: "keychain locked"))
        #expect(state.message != nil)
        state.apply(.paired(host, saveError: nil))
        #expect(state.message == nil)

        state.apply(.paired(host, saveError: "keychain locked"))
        state.clear()
        #expect(state.message == nil)
    }
}
