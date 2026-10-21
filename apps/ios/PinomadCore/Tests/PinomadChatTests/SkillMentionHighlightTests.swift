import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

@Suite struct SkillMentionHighlightTests {
    @Test func coreRangesBecomeNSRangesAroundEmoji() {
        let text = "🙂 $review 你好 $deploy-x"
        let ranges = SkillMentionHighlight.ranges(in: text, names: ["review", "deploy-x"])
        #expect(ranges == [
            NSRange(location: 3, length: 7),
            NSRange(location: 14, length: 9),
        ])
        #expect((text as NSString).substring(with: ranges[0]) == "$review")
        #expect((text as NSString).substring(with: ranges[1]) == "$deploy-x")
    }

    @Test func matchingStaysWithTheCoreRules() {
        let text = "$review $review-extra $HOME $$review"
        let ranges = SkillMentionHighlight.ranges(in: text, names: ["review", "HOME"])
        #expect(ranges == [NSRange(location: 0, length: 7)])
    }

    @Test func anEmptyListHighlightsNothing() {
        #expect(SkillMentionHighlight.ranges(in: "$review", names: []).isEmpty)
    }
}
