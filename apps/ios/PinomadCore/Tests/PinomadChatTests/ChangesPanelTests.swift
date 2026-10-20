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
        let first = panel.open(busy: false)
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
        let first = panel.open(busy: false)
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
    @Test func aLateResultAfterCloseIsDropped() {
        var panel = ChangesPanel()
        let token = panel.open(busy: false)
        panel.close()
        panel.land(token, changes("late", [file("late.swift")]))
        #expect(panel.changes == nil)
        #expect(!panel.loading)
        panel.fail(token, "late failure")
        #expect(panel.error == nil)
    }

    /// The panel follows the Web dialog: refresh once when a run settles.
    /// A busy value that was false on open, or unchanged false, is not a
    /// settling run and must not refetch.
    @Test func onlyTheFallingBusyEdgeRefreshes() throws {
        var panel = ChangesPanel()
        _ = panel.open(busy: false)
        #expect(panel.observe(busy: false) == nil)
        #expect(panel.observe(busy: true) == nil)
        let settledEdge = panel.observe(busy: false)
        let settled = try #require(settledEdge)
        #expect(panel.loading)
        #expect(panel.observe(busy: false) == nil)
        #expect(panel.observe(busy: true) == nil)
        let settledAgainEdge = panel.observe(busy: false)
        let settledAgain = try #require(settledAgainEdge)
        #expect(settled != settledAgain)
    }

    @Test func openingWhileBusySeesTheSettlingEdge() throws {
        var panel = ChangesPanel()
        _ = panel.open(busy: true)
        #expect(panel.observe(busy: true) == nil)
        let edge = panel.observe(busy: false)
        _ = try #require(edge)
        #expect(panel.loading)
    }

    /// A refresh is a refresh, not a reset: the last good result stays on
    /// screen (and stays readable) until the new one lands.
    @Test func refreshingKeepsTheLastGoodResult() throws {
        var panel = ChangesPanel()
        let first = panel.open(busy: false)
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
        let first = panel.open(busy: false)
        let old = changes()
        panel.land(first, old)
        let refresh = panel.refresh()
        panel.fail(try #require(refresh), "宿主没有响应")
        #expect(panel.changes == old)
        #expect(panel.error == "宿主没有响应")
        #expect(!panel.loading)
    }
}
