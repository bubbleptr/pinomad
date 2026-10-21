import Foundation
import PinomadCore

/// The core's `$name` matcher as Foundation ranges. The matching rules stay
/// in `pinomad-core` (shared with the Web client); this only converts the
/// UTF-16 half-open offsets to `NSRange`, which both `UITextView` and
/// `AttributedString` take directly.
public enum SkillMentionHighlight {
    public static func ranges(in text: String, names: [String]) -> [NSRange] {
        guard !names.isEmpty else { return [] }
        return skillMentionRanges(text: text, names: names).map { range in
            NSRange(location: Int(range.start), length: Int(range.end - range.start))
        }
    }
}
