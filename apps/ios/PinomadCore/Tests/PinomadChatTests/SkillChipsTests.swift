import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

/// A draft with `$name` picked at the `$` of `prefix + "$name"`.
private func picked(_ text: String, _ names: [String]) -> SkillChips {
    var chips = SkillChips(text: text)
    var searchFrom = text.startIndex
    for name in names {
        let range = text.range(of: "$" + name, range: searchFrom..<text.endIndex)!
        chips.bind(name, at: text.utf16.distance(from: text.startIndex, to: range.lowerBound))
        searchFrom = range.upperBound
    }
    return chips
}

@Suite struct SkillChipsPayloadTests {
    /// 5.16 and later: the picked names, deduplicated, in text order.
    @Test func picksAreSentInTextOrderOnce() {
        let chips = picked("ask $review then $deploy and $review again", ["review", "deploy", "review"])
        let payload = chips.payload(hostMinor: 16)
        #expect(payload.text == "ask $review then $deploy and $review again")
        #expect(payload.skills == ["review", "deploy"])
    }

    /// A typed `$review` is text only: it never reaches `skills`.
    @Test func aTypedMentionIsNotAPick() {
        let chips = picked("use $review, not \"$deploy\"", ["review"])
        #expect(chips.payload(hostMinor: 16).skills == ["review"])
    }

    @Test func noPicksSendAnEmptyList() {
        #expect(SkillChips(text: "plain").payload(hostMinor: 16).skills == [])
    }

    /// Before 5.16 the host would not know the argument: none is sent and
    /// the text carries the old behaviour.
    @Test func olderHostsGetNoSkillsArgument() {
        let chips = picked("ask $review", ["review"])
        #expect(chips.payload(hostMinor: 15).skills == nil)
        #expect(chips.payload(hostMinor: 15).text == "ask $review")
    }

    /// The bubble finds a mention only at a word start and before a
    /// non-word character, so a chip glued to text gets a space.
    @Test func gluedChipsAreSpacedSoBubblesFindThem() {
        var chips = picked("ask $review", ["review"])
        chips = chips.following("ask $reviewnow")
        #expect(chips.payload(hostMinor: 16).text == "ask $review now")
        // Text typed right before the chip is pushed off too.
        #expect(picked("$review", ["review"]).following("x$review").payload(hostMinor: 16).text == "x $review")
        // Punctuation already ends the mention: left alone.
        #expect(picked("ask $review, ok", ["review"]).payload(hostMinor: 16).text == "ask $review, ok")
    }
}

@Suite struct SkillChipsEditingTests {
    @Test func chipsShiftWithEditsAroundThem() {
        // One edit per change, as the field reports them.
        let chips = picked("ask $review now", ["review"])
            .following("please ask $review now")
            .following("please ask $review right now")
        #expect(chips.ranges == [NSRange(location: 11, length: 7)])
    }

    /// The diff of an insert next to a chip is ambiguous; the chip keeps
    /// whichever place still reads `$name`.
    @Test func anInsertAtTheChipStartKeepsIt() {
        let chips = picked("$review", ["review"]).following("$$review")
        #expect(chips.ranges == [NSRange(location: 1, length: 7)])
    }

    /// Typing inside a chip unbinds it; the text stays.
    @Test func editingInsideUnbinds() {
        let chips = picked("ask $review", ["review"]).following("ask $revXiew")
        #expect(chips.ranges.isEmpty)
        #expect(chips.payload(hostMinor: 16).skills == [])
    }

    /// Backspace touching a chip removes the whole chip.
    @Test func aDeletionIntoAChipCoversAllOfIt() {
        let chips = picked("ask $review now", ["review"])
        #expect(chips.deletion(expanding: NSRange(location: 10, length: 1)) == NSRange(location: 4, length: 7))
        #expect(chips.deletion(expanding: NSRange(location: 2, length: 4)) == NSRange(location: 2, length: 9))
        // Outside any chip: unchanged.
        #expect(chips.deletion(expanding: NSRange(location: 11, length: 1)) == NSRange(location: 11, length: 1))
    }

    @Test func clearingTheDraftDropsEveryChip() {
        #expect(picked("ask $review", ["review"]).following("").ranges.isEmpty)
    }

    /// Binding only takes where the text really reads `$name`.
    @Test func bindingNeedsTheMentionText() {
        var chips = SkillChips(text: "ask $rev")
        chips.bind("review", at: 4)
        #expect(chips.ranges.isEmpty)
    }
}

@Suite struct SkillChipsRestoreTests {
    /// A queued message's Edit gives back text plus the names the host
    /// expanded; those mentions become chips again, others stay text.
    @Test func restoredFromAQueuedInput() {
        let chips = SkillChips.restored(text: "ask $review and $deploy", skills: ["review"])
        #expect(chips.ranges == [NSRange(location: 4, length: 7)])
        #expect(chips.payload(hostMinor: 16).skills == ["review"])
    }

    @Test func restoredWithoutSkillsHasNoChips() {
        #expect(SkillChips.restored(text: "ask $review", skills: []).ranges.isEmpty)
    }
}
