import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

@Suite struct EditAvailabilityTests {
    @Test func anEmptyIdleComposerCanEdit() {
        let availability = EditAvailability(
            draft: "  \n", hasImages: false, hasFiles: false, preparing: false, anotherEdit: false
        )
        #expect(!availability.isDisabled)
        #expect(availability.tooltip == nil)
    }

    @Test func aDraftAttachmentOrUploadBlocksEditing() {
        for availability in [
            EditAvailability(draft: "hi", hasImages: false, hasFiles: false, preparing: false, anotherEdit: false),
            EditAvailability(draft: "", hasImages: true, hasFiles: false, preparing: false, anotherEdit: false),
            EditAvailability(draft: "", hasImages: false, hasFiles: true, preparing: false, anotherEdit: false),
            EditAvailability(draft: "", hasImages: false, hasFiles: false, preparing: true, anotherEdit: false),
        ] {
            #expect(availability.isDisabled)
            #expect(availability.reason == .composerOccupied)
            #expect(availability.tooltip == "Clear the composer to edit")
        }
    }

    @Test func anotherEditInFlightBlocksAndSaysSo() {
        let availability = EditAvailability(
            draft: "", hasImages: false, hasFiles: false, preparing: false, anotherEdit: true
        )
        #expect(availability.reason == .anotherEditInFlight)
        #expect(availability.tooltip == "Finish the current edit first")
    }

    @Test func anOccupiedComposerExplainsItselfBeforeTheEditLock() {
        let availability = EditAvailability(
            draft: "hi", hasImages: false, hasFiles: false, preparing: false, anotherEdit: true
        )
        #expect(availability.reason == .composerOccupied)
    }
}

@Suite struct PendingTakeBackTests {
    private var draft: SubmissionDraft {
        SubmissionDraft(
            text: "hello", whenBusy: .followUp, images: [], skills: ["review"],
            attachments: ["a1"]
        )
    }

    @Test func theDraftBelongsToTheConversationItCameFrom() {
        let pending = PendingTakeBack(conversationId: 1, draft: draft)
        #expect(pending.draft(for: 1) == draft)
        #expect(pending.draft(for: 2) == nil)
        #expect(pending.draft(for: nil) == nil)
    }
}
