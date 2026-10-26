import Testing
@testable import PinomadChat
import PinomadCore

@Suite struct SendSlotTests {
    /// The slot never empties: idle with nothing to send, Send stays in
    /// place, disabled, so the trailing edge always reads send or stop.
    @Test func emptyDraftWhileIdleDisablesSend() {
        #expect(SendSlot(draft: "", connected: true, busy: false) == .send(enabled: false, canSteer: false))
        #expect(SendSlot(draft: "  \n ", connected: true, busy: false) == .send(enabled: false, canSteer: false))
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

@Suite struct ComposerSubmitTests {
    private func command(_ name: String, disabled: String? = nil) -> CommandEntry {
        CommandEntry(name: name, description: "", argumentHint: nil, source: .builtin, disabled: disabled)
    }

    private var listing: [CommandEntry] {
        [command("compact"), command("review", disabled: "Nothing to review")]
    }

    @Test func aListedCommandRunsWithItsArguments() {
        #expect(ComposerSubmit(draft: "/compact", commands: listing, hasImages: false)
            == .command(name: "compact", args: nil))
        #expect(ComposerSubmit(draft: "/compact  keep the API notes \n", commands: listing, hasImages: false)
            == .command(name: "compact", args: "keep the API notes"))
    }

    /// The recognition rule is the core's: anything else is a message.
    @Test func everythingElseIsAMessage() {
        for draft in ["/usr/bin/x", "/foo", "/compactX", " /compact", "hello /compact", "compact"] {
            #expect(ComposerSubmit(draft: draft, commands: listing, hasImages: false) == .message)
        }
    }

    /// Without a listing (an old host, no answer yet, the draft page) no
    /// text is a command.
    @Test func anUnknownListingSendsAMessage() {
        #expect(ComposerSubmit(draft: "/compact", commands: nil, hasImages: false) == .message)
    }

    @Test func imagesBlockACommand() {
        guard case .blocked = ComposerSubmit(draft: "/compact", commands: listing, hasImages: true) else {
            Issue.record("expected blocked")
            return
        }
        // A message with images is unaffected.
        #expect(ComposerSubmit(draft: "look", commands: listing, hasImages: true) == .message)
    }

    /// A disabled command is still recognized (it must not leak to the
    /// model as text) and is held with the host's reason.
    @Test func aDisabledCommandIsHeldWithItsReason() {
        guard case .blocked(let reason) = ComposerSubmit(draft: "/review", commands: listing, hasImages: false) else {
            Issue.record("expected blocked")
            return
        }
        #expect(reason.contains("Nothing to review"))
    }
}

@Suite struct CommandSendSlotTests {
    /// Commands run at once: no steer / follow-up choice while busy.
    @Test func aCommandNeverOffersSteering() {
        #expect(SendSlot(draft: "/compact", connected: true, busy: true, command: true)
            == .send(enabled: true, canSteer: false))
    }
}
