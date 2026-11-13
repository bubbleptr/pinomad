import Testing
@testable import PinomadChat

/// Mirrors `conversationTitleProblem` in packages/protocol/src/view.ts.
@Suite struct ConversationTitleTests {
    @Test func blankIsAProblem() {
        #expect(ConversationTitle.problem("   ") == "Title cannot be empty")
    }

    @Test func overTheLimitIsAProblem() {
        #expect(ConversationTitle.problem(String(repeating: "a", count: 201))
            == "Title is too long (200 characters at most)")
        #expect(ConversationTitle.problem("  " + String(repeating: "a", count: 200) + "  ") == nil)
    }

    /// The host counts UTF-16 units, as JavaScript's `length` does.
    @Test func lengthIsCountedInUTF16() {
        #expect(ConversationTitle.problem(String(repeating: "😀", count: 101)) != nil)
        #expect(ConversationTitle.problem(String(repeating: "😀", count: 100)) == nil)
    }
}
