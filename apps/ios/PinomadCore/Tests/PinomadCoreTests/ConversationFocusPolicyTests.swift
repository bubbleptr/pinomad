import Testing
@testable import PinomadCore

/// A runtime releases its conversation when the screen no longer shows it
/// (ADR-0035 §2). The regressions that matter are a conversation created on
/// a host after focus moved away, and a focused host still switching onto
/// the target conversation.
@Suite("Conversation focus policy")
struct ConversationFocusPolicyTests {
    @Test func aBackgroundConversationIsReleased() {
        #expect(shouldReleaseConversation(
            isFocused: false,
            focusedConversationId: nil,
            shownConversationId: 42,
            sideConversationId: nil,
            isConnected: true))
        // A side conversation keeps a subscription even without a main one.
        #expect(shouldReleaseConversation(
            isFocused: false,
            focusedConversationId: nil,
            shownConversationId: nil,
            sideConversationId: 7,
            isConnected: true))
    }

    @Test func aFocusedHostStillOpeningItsTargetIsNotReleased() {
        #expect(!shouldReleaseConversation(
            isFocused: true,
            focusedConversationId: 42,
            shownConversationId: 7,
            sideConversationId: nil,
            isConnected: true))
        #expect(!shouldReleaseConversation(
            isFocused: true,
            focusedConversationId: 42,
            shownConversationId: nil,
            sideConversationId: nil,
            isConnected: true))
    }

    @Test func aFocusedDraftReleasesAConversationLeftInTheSnapshot() {
        #expect(shouldReleaseConversation(
            isFocused: true,
            focusedConversationId: nil,
            shownConversationId: 42,
            sideConversationId: nil,
            isConnected: true))
        #expect(!shouldReleaseConversation(
            isFocused: true,
            focusedConversationId: nil,
            shownConversationId: nil,
            sideConversationId: nil,
            isConnected: true))
        // A create from the draft is about to navigate to the new
        // conversation; releasing in that gap would race the page.
        #expect(!shouldReleaseConversation(
            isFocused: true,
            focusedConversationId: nil,
            shownConversationId: 42,
            sideConversationId: nil,
            isConnected: true,
            isCreatingConversation: true))
    }

    @Test func aDisconnectedRuntimeReleasesNothing() {
        #expect(!shouldReleaseConversation(
            isFocused: false,
            focusedConversationId: nil,
            shownConversationId: 42,
            sideConversationId: 7,
            isConnected: false))
    }
}
