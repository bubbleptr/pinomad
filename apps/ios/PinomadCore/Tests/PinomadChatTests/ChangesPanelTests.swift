import Testing
@testable import PinomadChat
import PinomadCore

private func changes(_ base: String = "0123456789abcdef", _ files: [PatchFile] = []) -> ConversationChanges {
    .available(base: base, files: files, truncated: false, branch: nil)
}

private func file(_ path: String, additions: UInt64 = 1) -> PatchFile {
    PatchFile(
        path: path, oldPath: nil, isNew: false, isDeleted: false, binary: false,
        additions: additions, deletions: 0,
        lines: [PatchLine(kind: .add, text: "+x")]
    )
}

@Suite struct ChangesPanelTests {
    /// Two refreshes can overlap (a pull-to-refresh during the busy edge);
    /// the older answer must not replace the newer one.
    @Test func onlyTheNewestRequestLands() throws {
        var panel = ChangesPanel()
        let opened = panel.open(busy: false, connected: true)
        let first = try #require(opened)
        let refresh = panel.refresh()
        let second = try #require(refresh)
        let newer = changes("newer", [file("new.swift")])
        panel.land(second, newer)
        panel.land(first, changes("older", [file("old.swift")]))
        #expect(panel.changes == newer)
        #expect(!panel.loading)
    }

    @Test func aStaleFailureIsIgnored() throws {
        var panel = ChangesPanel()
        let opened = panel.open(busy: false, connected: true)
        let first = try #require(opened)
        let refresh = panel.refresh()
        let second = try #require(refresh)
        panel.fail(first, "older request failed")
        #expect(panel.error == nil)
        #expect(panel.loading)
        let newer = changes()
        panel.land(second, newer)
        #expect(panel.changes == newer)
    }

    /// A result arriving after the sheet closed belongs to nothing on
    /// screen; dropping it also keeps a reopen from showing stale data.
    @Test func aLateResultAfterCloseIsDropped() throws {
        var panel = ChangesPanel()
        let opened = panel.open(busy: false, connected: true)
        let token = try #require(opened)
        panel.close()
        panel.land(token, changes("late", [file("late.swift")]))
        #expect(panel.changes == nil)
        #expect(!panel.loading)
        panel.fail(token, "late failure")
        #expect(panel.error == nil)
    }

    /// The overview follows the Web card: refresh once when a run settles.
    /// A busy value that was false on open, or unchanged false, is not a
    /// settling run and must not refetch.
    @Test func onlyTheFallingBusyEdgeRefreshes() throws {
        var panel = ChangesPanel()
        _ = panel.open(busy: false, connected: true)
        #expect(panel.observe(busy: false, connected: true) == nil)
        #expect(panel.observe(busy: true, connected: true) == nil)
        let settledEdge = panel.observe(busy: false, connected: true)
        let settled = try #require(settledEdge)
        #expect(panel.loading)
        #expect(panel.observe(busy: false, connected: true) == nil)
        #expect(panel.observe(busy: true, connected: true) == nil)
        let settledAgainEdge = panel.observe(busy: false, connected: true)
        let settledAgain = try #require(settledAgainEdge)
        #expect(settled != settledAgain)
    }

    /// A streaming run keeps editing the checkout: opening mid-run does
    /// not ask, the settle does.
    @Test func openingWhileBusyWaitsForTheSettle() throws {
        var panel = ChangesPanel()
        #expect(panel.open(busy: true, connected: true) == nil)
        #expect(!panel.loading)
        #expect(panel.observe(busy: true, connected: true) == nil)
        let edge = panel.observe(busy: false, connected: true)
        _ = try #require(edge)
        #expect(panel.loading)
    }

    /// Opening offline cannot ask; the reconnect does. A reconnect also
    /// retries after a drop, when the last answer may be stale or failed.
    @Test func aReconnectRefreshes() throws {
        var panel = ChangesPanel()
        #expect(panel.open(busy: false, connected: false) == nil)
        let reconnected = panel.observe(busy: false, connected: true)
        _ = try #require(reconnected)
        #expect(panel.observe(busy: false, connected: false) == nil)
        let again = panel.observe(busy: false, connected: true)
        _ = try #require(again)
    }

    @Test func aReconnectMidRunWaitsForTheSettle() throws {
        var panel = ChangesPanel()
        _ = panel.open(busy: false, connected: true)
        #expect(panel.observe(busy: true, connected: false) == nil)
        #expect(panel.observe(busy: true, connected: true) == nil)
        let settled = panel.observe(busy: false, connected: true)
        _ = try #require(settled)
    }

    /// Pushing the file list is an explicit ask: it loads even mid-run
    /// when nothing is there yet, but never doubles an in-flight fetch or
    /// replaces a result already on screen.
    @Test func showingTheListLoadsOnlyWhenEmpty() throws {
        var panel = ChangesPanel()
        _ = panel.open(busy: true, connected: true)
        let demanded = panel.load()
        let token = try #require(demanded)
        #expect(panel.load() == nil)
        panel.land(token, changes())
        #expect(panel.load() == nil)
    }

    /// A refresh is a refresh, not a reset: the last good result stays on
    /// screen (and stays readable) until the new one lands.
    @Test func refreshingKeepsTheLastGoodResult() throws {
        var panel = ChangesPanel()
        let opened = panel.open(busy: false, connected: true)
        let first = try #require(opened)
        let old = changes("old", [file("old.swift")])
        panel.land(first, old)
        let refresh = panel.refresh()
        let second = try #require(refresh)
        #expect(panel.changes == old)
        #expect(panel.loading)
        #expect(panel.error == nil)
        let new = changes("new", [file("new.swift")])
        panel.land(second, new)
        #expect(panel.changes == new)
        #expect(!panel.loading)
    }

    @Test func aFailedRefreshKeepsTheLastGoodResult() throws {
        var panel = ChangesPanel()
        let opened = panel.open(busy: false, connected: true)
        let first = try #require(opened)
        let old = changes()
        panel.land(first, old)
        let refresh = panel.refresh()
        panel.fail(try #require(refresh), "The host didn't respond")
        #expect(panel.changes == old)
        #expect(panel.error == "The host didn't respond")
        #expect(!panel.loading)
    }
}
