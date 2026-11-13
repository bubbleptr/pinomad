import Foundation

/// The title rule the host enforces, checked before sending so an invalid
/// one never leaves the app. Mirrors `conversationTitleProblem` in
/// packages/protocol/src/view.ts.
public enum ConversationTitle {
    public static let maxLength = 200

    public static func problem(_ title: String) -> String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Title cannot be empty" }
        // JavaScript's `length`: UTF-16 units.
        if trimmed.utf16.count > maxLength { return "Title is too long (\(maxLength) characters at most)" }
        return nil
    }
}
