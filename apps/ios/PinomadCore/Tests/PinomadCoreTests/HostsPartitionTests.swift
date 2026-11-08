import Testing
@testable import PinomadCore

/// Settings → Hosts splits the account's hosts by what this device holds
/// now, not by the last list's status: an unpaired host must not vanish
/// from both halves until the next refresh (Web #641's review).
@Suite("Hosts partition")
struct HostsPartitionTests {
    private func row(
        _ id: String, status: AccountHostRowStatus, stored: String?
    ) -> AccountHostRow {
        AccountHostRow(
            hostId: id, name: id, online: true, pairing: .available,
            status: status, action: status == .paired ? .connect(hostKey: stored ?? id) : .pair,
            storedHostKey: stored)
    }

    @Test func pairedHostWhoseStoredPairingIsGoneIsOfferedAgain() {
        let split = AccountHosts.partition(
            rows: [row("mbp", status: .paired, stored: "key-mbp")], storedHostKeys: [])
        #expect(split.notPairedHere.map(\.hostId) == ["mbp"])
        #expect(split.issues.isEmpty)
    }

    @Test func pairedHostHeldHereStaysOutOfTheAccountHalf() {
        let split = AccountHosts.partition(
            rows: [
                row("mbp", status: .paired, stored: "key-mbp"),
                row("lab", status: .unpaired, stored: nil),
            ],
            storedHostKeys: ["key-mbp"])
        #expect(split.notPairedHere.map(\.hostId) == ["lab"])
        #expect(split.issues.isEmpty)
    }

    /// Refused or re-keyed hosts still held here get Pair again on their own
    /// row; once forgotten, they move to the account half like any other.
    @Test func issuesAttachToTheHostsStillHeldHere() {
        let split = AccountHosts.partition(
            rows: [
                row("old", status: .rejected, stored: "key-old"),
                row("studio", status: .keyChanged, stored: "key-studio"),
                row("gone", status: .keyChanged, stored: "key-gone"),
            ],
            storedHostKeys: ["key-old", "key-studio"])
        #expect(split.issues["key-old"]?.hostId == "old")
        #expect(split.issues["key-studio"]?.hostId == "studio")
        #expect(split.issues["key-gone"] == nil)
        #expect(split.notPairedHere.map(\.hostId) == ["gone"])
    }
}
