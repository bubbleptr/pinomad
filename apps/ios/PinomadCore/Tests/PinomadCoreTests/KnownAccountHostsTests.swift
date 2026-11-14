import Foundation
import Testing
@testable import PinomadCore

/// The "new host joined your account" notice (#497): once per iPhone per
/// join of a host (#531), never for what was already there when this iPhone first looked,
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

    private func row(_ id: String, joinedAt: Double? = nil) -> AccountHostRow {
        AccountHostRow(
            hostId: id, name: id, online: true, pairing: .available,
            status: .unpaired, action: .pair, storedHostKey: nil, joinedAt: joinedAt)
    }

    private func observe(_ known: KnownAccountHosts, _ ids: [String], user: String = "kieran") -> [String] {
        known.observe(serverOrigin: origin, username: user, hosts: ids.map { row($0) }).map(\.hostId)
    }

    private func observe(_ known: KnownAccountHosts, joins: [(String, Double)]) -> [String] {
        known.observe(serverOrigin: origin, username: "kieran", hosts: joins.map { row($0.0, joinedAt: $0.1) })
            .map(\.hostId)
    }

    private func dismiss(_ known: KnownAccountHosts, _ ids: [String]) {
        known.dismiss(serverOrigin: origin, username: "kieran", hostIds: ids)
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

    // MARK: - Join times (#531)

    /// A host removed and joined again is news again: a phished host that
    /// was taken off and talked back in must not come back quietly.
    @Test func aHostIsAnnouncedAgainWhenItJoinsAgain() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, joins: [])
        #expect(observe(known, joins: [("mbp", 1)]) == ["mbp"])
        dismiss(known, ["mbp"])
        #expect(observe(known, joins: [("mbp", 1)]).isEmpty)
        #expect(observe(known, joins: [("mbp", 2)]) == ["mbp"])
    }

    /// What this iPhone knew before join times carries over: its hosts
    /// count as seen for the join each has now, a host it hadn't seen is
    /// news, and a notice still waiting stays. The old record is left for
    /// an older build to keep reading.
    @Test func aHostKnownBeforeJoinTimesIsSeenForItsCurrentJoin() throws {
        let defaults = defaults()
        let legacy = KnownAccountHosts(defaults: defaults, key: KnownAccountHosts.legacyDefaultsKey)
        _ = legacy.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp")])
        _ = legacy.observe(serverOrigin: origin, username: "kieran", hosts: [row("mbp"), row("studio")])
        let before = defaults.string(forKey: KnownAccountHosts.legacyDefaultsKey)

        let known = KnownAccountHosts(defaults: defaults)
        #expect(observe(known, joins: [("mbp", 5), ("studio", 5), ("pi", 5)]) == ["studio", "pi"])
        #expect(observe(known, joins: [("mbp", 6)]) == ["studio", "pi", "mbp"])
        #expect(defaults.string(forKey: KnownAccountHosts.legacyDefaultsKey) == before)
    }

    /// Confirming a host's new join here covers that join, and only it.
    @Test func aConfirmHereCoversOneJoin() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, joins: [("mbp", 1)])
        known.add(serverOrigin: origin, username: "kieran", hostId: "mbp")
        #expect(observe(known, joins: [("mbp", 2)]).isEmpty)
        #expect(observe(known, joins: [("mbp", 3)]) == ["mbp"])
    }

    /// A confirm of a host already listed is spent by the next list, so
    /// it can't hide the host's next join.
    @Test func aConfirmOfAListedHostDoesntHideItsNextJoin() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, joins: [("mbp", 1)])
        known.add(serverOrigin: origin, username: "kieran", hostId: "mbp")
        #expect(observe(known, joins: [("mbp", 1)]).isEmpty)
        #expect(observe(known, joins: [("mbp", 2)]) == ["mbp"])
    }

    /// A join time too big to key by is no join time, not a crash.
    @Test func anOutOfRangeJoinTimeCountsAsNone() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, joins: [("mbp", 1)])
        #expect(observe(known, joins: [("mbp", 1e300)]).isEmpty)
    }

    /// A server that stops sending join times doesn't make every host news.
    @Test func noJoinTimesStaysQuiet() {
        let known = KnownAccountHosts(defaults: defaults())
        _ = observe(known, joins: [("mbp", 1)])
        #expect(observe(known, ["mbp"]).isEmpty)
    }
}
