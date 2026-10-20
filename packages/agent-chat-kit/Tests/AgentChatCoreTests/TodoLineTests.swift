import AgentChatCore
import Foundation
import Testing

@Suite struct TodoLineTests {
    let written = Date(timeIntervalSince1970: 5_000)

    let open = TodoList(items: [
        .init(text: "Reproduce the race", status: .completed),
        .init(text: "Write to a temp file", status: .completed),
        .init(text: "Rename into place", status: .inProgress),
        .init(text: "Fsync the directory", status: .pending),
    ])

    let done = TodoList(items: [
        .init(text: "Reproduce the race", status: .completed),
        .init(text: "Fix it", status: .completed),
    ])

    @Test func theRunThatWroteTheListShowsIt() {
        let line = TodoLine(list: done, writtenAt: written, isLatestRun: true)
        #expect(line?.writtenAt == written)
        #expect(line?.list.isFinished == true)
    }

    @Test func openItemsKeepTheLineUnderARunThatDidNotTouchIt() {
        let line = TodoLine(list: open, writtenAt: nil, isLatestRun: true)
        #expect(line?.list.completedCount == 2)
        #expect(line?.list.current?.text == "Rename into place")
    }

    @Test func aFinishedListDropsOffTheNextRun() {
        #expect(TodoLine(list: done, writtenAt: nil, isLatestRun: true) == nil)
    }

    @Test func onlyTheLatestRunCarriesIt() {
        #expect(TodoLine(list: open, writtenAt: written, isLatestRun: false) == nil)
    }

    @Test func noListOrAnEmptyOneShowsNothing() {
        #expect(TodoLine(list: nil, writtenAt: written, isLatestRun: true) == nil)
        #expect(TodoLine(list: TodoList(items: []), writtenAt: written, isLatestRun: true) == nil)
    }

    @Test func thePendingItemIsCurrentWhenNothingIsInProgress() {
        let list = TodoList(items: [
            .init(text: "Done", status: .completed),
            .init(text: "Next", status: .pending),
            .init(text: "Later", status: .pending),
        ])
        #expect(list.current?.text == "Next")
    }
}
