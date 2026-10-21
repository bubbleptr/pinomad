import Foundation
import PinomadCore

/// The core's `$name` matcher as Foundation ranges. The matching rules stay
/// in `pinomad-core` (shared with the Web client); this only converts the
/// UTF-16 half-open offsets to `NSRange`, which both `UITextView` and
/// `AttributedString` take directly.
public enum SkillMentionHighlight {
    /// `limit` is the receiving text storage's UTF-16 length. UIKit can
    /// briefly hold a shorter storage than the bound draft while SwiftUI
    /// is applying an update; a range past the end would throw.
    public static func ranges(in text: String, names: [String], limit: Int? = nil) -> [NSRange] {
        guard !names.isEmpty else { return [] }
        return skillMentionRanges(text: text, names: names).compactMap { range in
            let value = NSRange(location: Int(range.start), length: Int(range.end - range.start))
            if let limit, NSMaxRange(value) > limit { return nil }
            return value
        }
    }
}
