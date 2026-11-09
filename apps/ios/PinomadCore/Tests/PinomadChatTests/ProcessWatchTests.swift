import Testing
@testable import PinomadChat

@MainActor
private final class FakeProcessRuntime: ProcessWatching {
    var watched: [UInt64] = []
    var unwatched = 0

    func watchProcesses(_ root: UInt64) { watched.append(root) }
    func unwatchProcesses() { unwatched += 1 }
}

@MainActor
@Suite struct ProcessWatchTests {
    /// Focus can move to host B while host A's Overview is still up. Closing
    /// the sheet must unwatch A, not whatever host is focused now.
    @Test func closingUnwatchesTheRuntimeThatOpenedIt() {
        let a = FakeProcessRuntime()
        let b = FakeProcessRuntime()
        let watch = ProcessWatchSession()
        watch.open(root: 1, on: a)

        // Host B becomes focused; the sheet still owns host A's watch.
        watch.close()

        #expect(a.watched == [1])
        #expect(a.unwatched == 1)
        #expect(b.watched.isEmpty)
        #expect(b.unwatched == 0)
    }

    @Test func reopeningMovesTheWatchToTheNewRuntime() {
        let a = FakeProcessRuntime()
        let b = FakeProcessRuntime()
        let watch = ProcessWatchSession()
        watch.open(root: 1, on: a)
        watch.open(root: 2, on: b)

        #expect(a.unwatched == 1)
        #expect(b.watched == [2])

        watch.close()
        #expect(b.unwatched == 1)
    }

    @Test func closingTwiceUnwatchesOnlyOnce() {
        let a = FakeProcessRuntime()
        let watch = ProcessWatchSession()
        watch.open(root: 1, on: a)
        watch.close()
        watch.close()

        #expect(a.unwatched == 1)
    }
}
