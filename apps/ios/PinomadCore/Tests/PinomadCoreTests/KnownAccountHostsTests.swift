import Foundation
import Testing
@testable import PinomadCore

/// The "new host joined your account" notice (#497): once per iPhone per
/// host, never for what was already there when this iPhone first looked.
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

    /// The first list this iPhone sees is the baseline: hosts that were
    /// already on the account are not news.
    @Test func theFirstLoadSeedsSilently() {
        let known = KnownAccountHosts(defaults: defaults())
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp"), row("studio")]).isEmpty)
    }

    /// An account with no hosts is seeded too: its first host is news.
    @Test func anEmptyFirstLoadStillSeeds() {
        let known = KnownAccountHosts(defaults: defaults())
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: []).isEmpty)
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")]).map(\.hostId) == ["mbp"])
    }

    @Test func aNewHostIsAnnouncedOnce() {
        let defaults = defaults()
        let known = KnownAccountHosts(defaults: defaults)
        _ = known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")])
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp"), row("studio")])
            .map(\.hostId) == ["studio"])
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp"), row("studio")]).isEmpty)
        // Across a relaunch too.
        let reopened = KnownAccountHosts(defaults: defaults)
        #expect(reopened.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp"), row("studio")]).isEmpty)
    }

    /// A host confirmed on this iPhone is not news to it.
    @Test func aHostConfirmedHereIsNotAnnounced() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = known.observe(serverOrigin: origin, username: "kieran", hosts: [])
        known.add(serverOrigin: origin, username: "kieran", hostId: "studio")
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("studio")]).isEmpty)
    }

    /// Confirming before the first list must not seed a baseline of one
    /// host, which would announce every other host already there.
    @Test func confirmingBeforeTheFirstLoadDoesntSeed() {
        let known = KnownAccountHosts(defaults: defaults())
        known.add(serverOrigin: origin, username: "kieran", hostId: "studio")
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp"), row("studio")]).isEmpty)
    }

    /// A new sign-in starts a new baseline.
    @Test func resetSeedsAgain() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = known.observe(serverOrigin: origin, username: "kieran", hosts: [])
        known.reset(serverOrigin: origin, username: "kieran")
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")]).isEmpty)
    }

    /// Each account keeps its own baseline, and the origin's spelling
    /// doesn't split one account in two.
    @Test func accountsAreKeptApart() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")])
        #expect(known.observe(serverOrigin: origin, username: "guest", hosts: [row("mbp"), row("pi")]).isEmpty)
        #expect(known.observe(serverOrigin: origin + "/", username: "kieran", hosts: [row("mbp"), row("pi")])
            .map(\.hostId) == ["pi"])
    }

    /// A host that left the account and joined again is a new join.
    @Test func aHostThatLeftAndRejoinedIsAnnouncedAgain() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")])
        _ = known.observe(serverOrigin: origin, username: "kieran", hosts: [])
        #expect(known.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")]).map(\.hostId) == ["mbp"])
    }
}
