import Foundation
import Testing
@testable import PinomadCore

/// The "new host joined your account" notice (#497): once per iPhone per
/// host, never for what was already there when this iPhone first looked,
/// and not lost before the reader has seen it.
@Suite("Known account hosts")
@MainActor
struct KnownAccountHostsTests {
    private let origin = "https://accounts.example.com"

    private func defaults() -> UserDefaults {
        let suite = "KnownAccountHostsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func row(_ id: String) -> AccountHostRow {
        AccountHostRow(
            hostId: id, name: id, online: true, pairing: .available,
            status: .unpaired, action: .pair, storedHostKey: nil)
    }

    private func observe(_ known: KnownAccountHosts, _ ids: [String], user: String = "kieran") -> [String] {
        known.observe(serverOrigin: origin, username: user, hosts: ids.map(row)).map(\.hostId)
    }

    /// The first list this iPhone sees is the baseline: hosts that were
    /// already on the account are not news.
    @Test func theFirstLoadSeedsSilently() {
        let known = KnownAccountHosts(defaults: defaults())
        #expect(observe(known, ["mbp", "studio"]).isEmpty)
    }

    /// An account with no hosts is seeded too: its first host is news.
    @Test func anEmptyFirstLoadStillSeeds() {
        let known = KnownAccountHosts(defaults: defaults())
        #expect(observe(known, []).isEmpty)
        #expect(observe(known, ["mbp"]) == ["mbp"])
    }

    /// The notice waits for the reader: it stays pending through later
    /// rounds, and once dismissed it never comes back.
    @Test func aNewHostIsAnnouncedUntilDismissed() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, ["mbp"])
        #expect(observe(known, ["mbp", "studio"]) == ["studio"])
        #expect(observe(known, ["mbp", "studio"]) == ["studio"])
        #expect(known.pending(serverOrigin: origin, username: "kieran").map(\.name) == ["studio"])

        known.dismiss(serverOrigin: origin, username: "kieran", hostIds: ["studio"])
        #expect(observe(known, ["mbp", "studio"]).isEmpty)
        #expect(known.pending(serverOrigin: origin, username: "kieran").isEmpty)
    }

    /// iOS can kill the app while the notice waits for a sheet to close:
    /// the next launch still has it, and only a dismissal ends it.
    @Test func aPendingNoticeSurvivesARelaunch() {
        let defaults = defaults()
        let known = KnownAccountHosts(defaults: defaults)
        _ = observe(known, ["mbp"])
        _ = observe(known, ["mbp", "studio"])

        let relaunched = KnownAccountHosts(defaults: defaults)
        #expect(relaunched.pending(serverOrigin: origin, username: "kieran")
            == [PendingAccountHost(hostId: "studio", name: "studio")])
        relaunched.dismiss(serverOrigin: origin, username: "kieran", hostIds: ["studio"])

        let again = KnownAccountHosts(defaults: defaults)
        #expect(again.pending(serverOrigin: origin, username: "kieran").isEmpty)
        #expect(observe(again, ["mbp", "studio"]).isEmpty)
    }

    /// A host confirmed on this iPhone is not news to it.
    @Test func aHostConfirmedHereIsNotAnnounced() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, [])
        known.add(serverOrigin: origin, username: "kieran", hostId: "studio")
        #expect(observe(known, ["studio"]).isEmpty)
    }

    /// A refresh can list the host just before Confirm's answer lands; the
    /// confirmation still takes it out of the notice.
    @Test func confirmingAfterTheListSawItWithdrawsTheNotice() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, [])
        #expect(observe(known, ["studio"]) == ["studio"])
        known.add(serverOrigin: origin, username: "kieran", hostId: "studio")
        #expect(known.pending(serverOrigin: origin, username: "kieran").isEmpty)
    }

    /// Confirming before the first list must not seed a baseline of one
    /// host, which would announce every other host already there.
    @Test func confirmingBeforeTheFirstLoadDoesntSeed() {
        let known = KnownAccountHosts(defaults: defaults())
        known.add(serverOrigin: origin, username: "kieran", hostId: "studio")
        #expect(observe(known, ["mbp", "studio"]).isEmpty)
    }

    /// A new sign-in starts a new baseline.
    @Test func resetSeedsAgain() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, [])
        _ = observe(known, ["mbp"])
        known.reset(serverOrigin: origin, username: "kieran")
        #expect(known.pending(serverOrigin: origin, username: "kieran").isEmpty)
        #expect(observe(known, ["mbp", "pi"]).isEmpty)
    }

    /// Each account keeps its own baseline, and the origin's spelling
    /// doesn't split one account in two.
    @Test func accountsAreKeptApart() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, ["mbp"])
        #expect(observe(known, ["mbp", "pi"], user: "guest").isEmpty)
        #expect(known.observe(serverOrigin: origin + "/", username: "kieran", hosts: [row("mbp"), row("pi")])
            .map(\.hostId) == ["pi"])
    }

    /// A refresh already on its way when Confirm landed answers without the
    /// new host; that answer mustn't undo the mark, or the next one would
    /// announce the host this iPhone just confirmed.
    @Test func aListFromBeforeTheConfirmKeepsTheMark() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, ["mbp"])
        known.add(serverOrigin: origin, username: "kieran", hostId: "studio")
        #expect(observe(known, ["mbp"]).isEmpty)
        #expect(observe(known, ["mbp", "studio"]).isEmpty)
    }
}
