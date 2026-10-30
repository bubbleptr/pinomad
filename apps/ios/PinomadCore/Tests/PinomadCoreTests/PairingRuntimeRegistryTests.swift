import Testing
@testable import PinomadCore

/// Manual pairing owns the screen; a background account registration must not
/// take that ownership away (ADR-0035 §5).
@Suite("Pairing runtime registry")
struct PairingRuntimeRegistryTests {
    @Test func manualPairingStaysFocusedWhenAnAutomaticOneStarts() {
        var registry = PairingRuntimeRegistry()
        registry.start(.manual)
        #expect(registry.focusOwner == .manual)
        #expect(registry.isManualActive)

        registry.start(.automatic(hostId: "account-host"))
        #expect(registry.focusOwner == .manual)
        #expect(registry.isManualActive)
    }

    @Test func automaticRegistrationNeverOwnsFocus() {
        var registry = PairingRuntimeRegistry()
        registry.start(.automatic(hostId: "account-host"))
        #expect(registry.focusOwner == nil)
        #expect(!registry.isManualActive)
    }

    @Test func finishingTheManualPairingReleasesFocus() {
        var registry = PairingRuntimeRegistry()
        registry.start(.manual)
        registry.finish(.manual)
        #expect(registry.focusOwner == nil)
        #expect(!registry.isManualActive)
    }
}
