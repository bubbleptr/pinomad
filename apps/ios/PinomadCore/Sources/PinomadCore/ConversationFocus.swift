import Foundation

/// Whether a runtime must give up its conversation subscription because it is
/// no longer what the screen shows (ADR-0035 §2). The runtime itself decides
/// when to ask; this is the pure rule.
///
/// A focused runtime that is opening a conversation is never released: its
/// snapshot may still show the previous one while the switch is in flight.
/// The focused draft is different — a conversation left in the snapshot must
/// be cleared. An unfocused runtime keeps only host-level streams, so any
/// main or side conversation it still shows is stale.
public func shouldReleaseConversation(
    isFocused: Bool,
    focusedConversationId: UInt64?,
    shownConversationId: UInt64?,
    sideConversationId: UInt64?,
    isConnected: Bool,
    isCreatingConversation: Bool = false
) -> Bool {
    // A create from the draft page navigates once the new snapshot lands;
    // releasing it in that gap would cancel the page it is about to show.
    guard isConnected, !isCreatingConversation else { return false }
    guard shownConversationId != nil || sideConversationId != nil else { return false }
    guard isFocused else { return true }
    return focusedConversationId == nil
}
