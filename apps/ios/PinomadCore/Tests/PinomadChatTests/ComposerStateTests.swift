import Testing
@testable import PinomadChat
import PinomadCore

@Suite struct SendSlotTests {
    @Test func emptyDraftWhileIdleShowsNothing() {
        #expect(SendSlot(draft: "", connected: true, busy: false) == .hidden)
        #expect(SendSlot(draft: "  \n ", connected: true, busy: false) == .hidden)
    }

    @Test func emptyDraftWhileBusyOffersStop() {
        #expect(SendSlot(draft: "", connected: true, busy: true) == .stop(enabled: true))
    }

    @Test func draftOffersSendWhetherOrNotBusy() {
        #expect(SendSlot(draft: "hi", connected: true, busy: false) == .send(enabled: true, canSteer: false))
        #expect(SendSlot(draft: "hi", connected: true, busy: true) == .send(enabled: true, canSteer: true))
    }

    /// Offline calls "succeed" with only a notice — sending would drop
    /// the draft, so neither send nor stop is live while disconnected.
    @Test func offlineDisablesSendAndStop() {
        #expect(SendSlot(draft: "hi", connected: false, busy: true) == .send(enabled: false, canSteer: true))
        #expect(SendSlot(draft: "", connected: false, busy: true) == .stop(enabled: false))
    }
}

@Suite struct NoticeFeedTests {
    private func notice(_ id: UInt64) -> Notice {
        Notice(id: id, level: "error", message: "n\(id)")
    }

    @Test func noticesPresentOnFirstLookAreNotToasted() {
        var feed = NoticeFeed()
        #expect(feed.fresh([notice(1), notice(2)]).isEmpty)
        #expect(feed.fresh([notice(1), notice(2), notice(3)]).map(\.id) == [3])
    }

    @Test func eachNoticeToastsOnce() {
        var feed = NoticeFeed()
        _ = feed.fresh([])
        #expect(feed.fresh([notice(1)]).map(\.id) == [1])
        #expect(feed.fresh([notice(1)]).isEmpty)
    }

    /// The core caps the list at 20 — ids older than the cap fall off the
    /// front, which must not replay anything.
    @Test func cappedListDroppingOldIdsReplaysNothing() {
        var feed = NoticeFeed()
        _ = feed.fresh((1...20).map(notice))
        #expect(feed.fresh((2...21).map(notice)).map(\.id) == [21])
    }
}
