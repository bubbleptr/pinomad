import AgentChatCore
import Foundation
import Testing

@Suite struct TodoLineTests {
    let earlier = Date(timeIntervalSince1970: 5_000)
    let later = Date(timeIntervalSince1970: 9_000)

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

    @Test func theNewestRunHavingWrittenTheListShowsIt() {
        let line = TodoLine(list: done, runWrites: [nil, later])
        #expect(line?.writtenAt == later)
        #expect(line?.list.isFinished == true)
    }

    /// The newest run did not touch an unfinished list: the line stays, and
    /// says when an earlier run last wrote it — that is when it most likely
    /// went stale.
    @Test func openItemsKeepTheLineAndDateItFromTheLastWriteAnywhere() {
        let line = TodoLine(list: open, runWrites: [earlier, later, nil])
        #expect(line?.writtenAt == later)
        #expect(line?.list.completedCount == 2)
        #expect(line?.list.current?.text == "Rename into place")
    }

    @Test func runsAreNotAssumedToWriteInTimeOrder() {
        // A clock step between runs must not hide the newest write.
        let line = TodoLine(list: open, runWrites: [later, earlier])
        #expect(line?.writtenAt == later)
    }

    @Test func aFinishedListDropsOffARunThatDidNotWriteIt() {
        #expect(TodoLine(list: done, runWrites: [later, nil]) == nil)
    }

    @Test func aListNoRunWroteHasNoDate() {
        #expect(TodoLine(list: open, runWrites: [nil, nil])?.writtenAt == nil)
    }

    @Test func noRunNoListOrAnEmptyListShowsNothing() {
        #expect(TodoLine(list: open, runWrites: []) == nil)
        #expect(TodoLine(list: nil, runWrites: [later]) == nil)
        #expect(TodoLine(list: TodoList(items: []), runWrites: [later]) == nil)
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
