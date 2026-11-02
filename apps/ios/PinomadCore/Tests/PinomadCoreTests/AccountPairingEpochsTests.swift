import Testing
@testable import PinomadCore

/// Which in-flight account pairing asks a late answer may still act on
/// (#512): removing or forgetting one host makes only that host's asks
/// stale, while a sign-in change or a chosen connection makes all of them
/// stale.
@Suite("Account pairing epochs")
struct AccountPairingEpochsTests {
    @Test func invalidatingOneHostLeavesTheOthersCurrent() {
        var epochs = AccountPairingEpochs()
        let removed = epochs.ticket(hostId: "a")
        let other = epochs.ticket(hostId: "b")
        let explicit = epochs.ticket()

        epochs.invalidate(hostId: "a")

        #expect(!epochs.isCurrent(removed))
        #expect(epochs.isCurrent(other))
        #expect(epochs.isCurrent(explicit))
    }

    /// A list refresh that was already in flight can start the removed
    /// host's registration again; the ask from before the removal stays
    /// stale even though a newer one for the same host is current.
    @Test func anAskFromBeforeTheInvalidationStaysStale() {
        var epochs = AccountPairingEpochs()
        let before = epochs.ticket(hostId: "a")
        epochs.invalidate(hostId: "a")
        let after = epochs.ticket(hostId: "a")

        #expect(!epochs.isCurrent(before))
        #expect(epochs.isCurrent(after))
    }

    @Test func invalidatingAllMakesEveryAskStale() {
        var epochs = AccountPairingEpochs()
        let host = epochs.ticket(hostId: "a")
        let explicit = epochs.ticket()

        epochs.invalidateAll()

        #expect(!epochs.isCurrent(host))
        #expect(!epochs.isCurrent(explicit))
        #expect(epochs.isCurrent(epochs.ticket(hostId: "a")))
    }
}
