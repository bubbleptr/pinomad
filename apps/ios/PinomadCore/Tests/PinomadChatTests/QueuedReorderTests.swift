import PinomadChat
import PinomadCore
import Testing

@Suite struct QueuedReorderTests {
    private func item(_ id: UInt64, _ mode: QueueMode) -> QueueItem {
        QueueItem(id: id, mode: mode, text: "\(id)", imageCount: 0, attachmentCount: 0)
    }

    @Test func peersAreHostInputsOfTheSameMode() {
        let items = [item(1, .followUp), item(2, .steer), item(3, .write), item(4, .followUp)]
        #expect(QueuedList.peers(of: items[0], in: items).map(\.id) == [1, 4])
        #expect(QueuedList.peers(of: items[1], in: items).map(\.id) == [2])
        #expect(QueuedList.peers(of: items[2], in: items).isEmpty)
        #expect(QueuedList.peers(of: item(5, .other("x")), in: items).isEmpty)
    }

    @Test func movingUpLandsBeforeThePreviousPeer() {
        let items = [item(1, .followUp), item(2, .steer), item(3, .followUp)]
        #expect(QueuedList.move(3, by: -1, in: items) == QueuedMove(before: 1))
        #expect(QueuedList.move(1, by: -1, in: items) == nil)
    }

    /// Down means after the next peer: the input right after it in the whole
    /// inbox, skipping the moved row and writes (the host refuses a write as
    /// `before`), or the end.
    @Test func movingDownLandsAfterTheNextPeer() {
        let items = [item(1, .followUp), item(2, .followUp), item(3, .write), item(4, .steer)]
        #expect(QueuedList.move(1, by: 1, in: items) == QueuedMove(before: 4))
        let tail = [item(1, .followUp), item(2, .steer), item(3, .followUp), item(4, .write)]
        #expect(QueuedList.move(1, by: 1, in: tail) == QueuedMove(before: nil))
        #expect(QueuedList.move(3, by: 1, in: tail) == nil)
    }

    @Test func dropSideMapsToBefore() {
        let items = [item(1, .steer), item(2, .steer), item(3, .steer)]
        #expect(QueuedList.before(moving: 3, onto: 1, side: .before, in: items) == 1)
        #expect(QueuedList.before(moving: 1, onto: 2, side: .after, in: items) == 3)
        #expect(QueuedList.before(moving: 1, onto: 3, side: .after, in: items) == nil)
    }

    @Test func writesAndUnknownModesNeverMove() {
        let items = [item(1, .write), item(2, .write)]
        #expect(QueuedList.move(1, by: 1, in: items) == nil)
        #expect(QueuedList.move(2, by: -1, in: items) == nil)
    }
}
