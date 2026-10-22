import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func command(
    _ name: String,
    _ description: String = "",
    hint: String? = nil,
    disabled: String? = nil
) -> CommandEntry {
    CommandEntry(name: name, description: description, argumentHint: hint,
                 source: .builtin, disabled: disabled)
}

private let listing = [
    command("compact", "Summarize older messages", hint: "[instructions]"),
    command("context", "Show what the model sees"),
    command("review", "Review the diff", disabled: "Nothing to review"),
]

@Suite struct SlashCommandMenuTests {
    private func menu(_ text: String, cursor: Int? = nil, commands: [CommandEntry]? = listing) -> SlashCommandMenu {
        var menu = SlashCommandMenu()
        menu.refresh(text: text, cursor: cursor ?? (text as NSString).length, commands: commands)
        return menu
    }

    @Test func aBareSlashListsEveryCommand() {
        let menu = menu("/")
        #expect(menu.isShowing)
        #expect(menu.commands.map(\.name) == ["compact", "context", "review"])
    }

    @Test func theTypedPrefixFilters() {
        #expect(menu("/co").commands.map(\.name) == ["compact", "context"])
        #expect(menu("/COM").commands.map(\.name) == ["compact"])
        // A prefix, not a substring: `/act` does not find compact.
        #expect(menu("/act").commands.isEmpty)
    }

    /// A non-matching start (a path, a typo) still shows the menu so the
    /// reader sees it will go out as a message.
    @Test func noMatchKeepsTheMenuOpenEmpty() {
        let menu = menu("/usr")
        #expect(menu.isShowing)
        #expect(menu.commands.isEmpty)
    }

    /// Commands are a whole message's intent: a slash anywhere but index 0
    /// is a path or prose, never a trigger.
    @Test func onlyAtTheStartOfTheMessage() {
        #expect(!menu("hello /co").isShowing)
        #expect(!menu(" /co").isShowing)
        #expect(!menu("line\n/co").isShowing)
        #expect(!menu("a/co").isShowing)
    }

    @Test func theCaretMustBeInsideTheFirstToken() {
        // After the space that ends the name: typing arguments.
        #expect(!menu("/compact keep notes").isShowing)
        #expect(!menu("/compact ").isShowing)
        // Before the slash.
        #expect(!menu("/compact", cursor: 0).isShowing)
        // Mid-token: the query is what precedes the caret.
        let mid = menu("/compact keep", cursor: 3)
        #expect(mid.isShowing)
        #expect(mid.commands.map(\.name) == ["compact", "context"])
    }

    @Test func disabledCommandsStayListedWithTheirReason() {
        let menu = menu("/rev")
        #expect(menu.commands.map(\.name) == ["review"])
        #expect(menu.commands.first?.disabled == "Nothing to review")
    }

    /// An unknown listing (no answer yet, an old host, the draft page)
    /// never opens the menu; a later answer can open it without retyping.
    @Test func anUnknownListingStaysClosed() {
        var menu = SlashCommandMenu()
        menu.refresh(text: "/co", cursor: 3, commands: nil)
        #expect(!menu.isShowing)
        menu.refresh(text: "/co", cursor: 3, commands: listing)
        #expect(menu.isShowing)
    }

    @Test func choosingReplacesTheFirstTokenWithATrailingSpace() throws {
        let typed = menu("/co")
        let insertion = try #require(typed.insertion(for: listing[0], in: "/co"))
        #expect(insertion == MentionInsertion(text: "/compact ", cursor: 9))

        // Caret parked mid-token: the whole token goes, the args stay.
        let text = "/cxyz keep notes"
        let parked = menu(text, cursor: 2)
        let replaced = try #require(parked.insertion(for: listing[0], in: text))
        #expect(replaced == MentionInsertion(text: "/compact keep notes", cursor: 9))
    }
}

@Suite struct ComposerTriggerTests {
    private func insert(_ trigger: String, _ text: String, at location: Int, length: Int = 0) -> MentionInsertion {
        ComposerTrigger.insert(trigger, into: text, selection: NSRange(location: location, length: length))
    }

    @Test func emptyDraftGetsTheBareTrigger() {
        #expect(insert("@", "", at: 0) == MentionInsertion(text: "@", cursor: 1))
    }

    @Test func aWordBeforeTheCaretGetsALeadingSpace() {
        #expect(insert("$", "ask", at: 3) == MentionInsertion(text: "ask $", cursor: 5))
        #expect(insert("$", "ask ", at: 4) == MentionInsertion(text: "ask $", cursor: 5))
        #expect(insert("@./", "see\n", at: 4) == MentionInsertion(text: "see\n@./", cursor: 7))
    }

    /// Text right after the caret would join the new token and be eaten by
    /// the pick, so it is pushed one space away.
    @Test func aWordAfterTheCaretIsKeptApart() {
        #expect(insert("@", "ask bob", at: 4) == MentionInsertion(text: "ask @ bob", cursor: 5))
        #expect(insert("@", "askbob", at: 3) == MentionInsertion(text: "ask @ bob", cursor: 5))
        #expect(insert("@", "ask bob", at: 3) == MentionInsertion(text: "ask @ bob", cursor: 5))
    }

    @Test func aSelectionIsReplaced() {
        #expect(insert("$", "ask this please", at: 4, length: 4)
            == MentionInsertion(text: "ask $ please", cursor: 5))
    }

    @Test func offsetsAreUTF16() {
        // 你(1) 好(1) emoji(2) = 4 units.
        #expect(insert("@", "你好🙂", at: 4) == MentionInsertion(text: "你好🙂 @", cursor: 6))
    }

    @Test func anOutOfRangeCaretLandsAtTheEnd() {
        #expect(insert("@", "hi", at: 99) == MentionInsertion(text: "hi @", cursor: 4))
    }
}
