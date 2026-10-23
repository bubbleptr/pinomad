import Foundation
import PinomadCore

/// The `$` menu picks bound in a draft (issue #308, ADR-0028). The draft
/// stays a plain String with `$name` in it; a chip is a UTF-16 range over
/// that text plus the skill it binds. Only chips fire on the host — a
/// hand-typed `$name` is text.
///
/// The value remembers the text its ranges belong to, so any change to the
/// draft (typing, a menu insertion, a clear) is followed with
/// `following(_:)`: chips around the edit shift, a chip the edit cut into
/// is dropped (editing inside unbinds), and the field turns a deletion
/// that touches a chip into one over the whole chip.
public struct SkillChips: Equatable, Sendable {
    public struct Chip: Equatable, Sendable {
        public let name: String
        /// UTF-16 offsets of `$` through the name's end.
        public let range: Range<Int>
    }

    /// The draft text the chip ranges are valid for.
    public private(set) var text: String
    /// Chips in text order, never overlapping.
    public private(set) var chips: [Chip] = []
    /// The state one edit back, so an undo that restores that exact text
    /// gets its bindings back too (a chip deletion is then reversible).
    private var previousText: String?
    private var previousChips: [Chip] = []

    public init(text: String = "") {
        self.text = text
    }

    /// The chips a queued input's Edit gives back: every lexical `$name`
    /// mention whose name the host expanded (`QueuedInput.skills`).
    public static func restored(text: String, skills: [String]) -> SkillChips {
        var value = SkillChips(text: text)
        guard !skills.isEmpty else { return value }
        let units = Array(text.utf16)
        value.chips = skillMentionRanges(text: text, names: skills).map { range in
            let start = Int(range.start), end = Int(range.end)
            let name = String(decoding: units[(start + 1)..<end], as: UTF16.self)
            return Chip(name: name, range: start..<end)
        }
        return value
    }

    /// Bind `name` at the `$` at `location` — what a `$` menu pick inserted.
    /// Nothing is bound unless the text there reads `$name`.
    public mutating func bind(_ name: String, at location: Int) {
        let range = location..<(location + 1 + name.utf16.count)
        guard Self.reads(Array(text.utf16), range: range, name: name) else { return }
        chips.removeAll { $0.range.overlaps(range) }
        chips.append(Chip(name: name, range: range))
        chips = Self.normalized(chips, length: text.utf16.count)
    }

    /// The chips moved onto `new`, one contiguous edit away from `text`. A
    /// chip clear of the edit shifts with it; one the edit touches survives
    /// only where `$name` still reads intact (an insert right at its edge
    /// diffs ambiguously), otherwise it is unbound.
    public func following(_ new: String) -> SkillChips {
        guard new != text else { return self }
        if new == previousText {
            var undone = SkillChips(text: new)
            undone.chips = Self.normalized(previousChips, length: new.utf16.count)
            undone.previousText = text
            undone.previousChips = chips
            return undone
        }
        let old = Array(text.utf16), next = Array(new.utf16)
        var prefix = 0
        while prefix < old.count, prefix < next.count, old[prefix] == next[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix, suffix < next.count - prefix,
              old[old.count - 1 - suffix] == next[next.count - 1 - suffix] { suffix += 1 }
        let editEnd = old.count - suffix
        let delta = next.count - old.count

        var value = SkillChips(text: new)
        value.previousText = text
        value.previousChips = chips
        var kept: [Chip] = []
        for chip in chips {
            let shifted = (chip.range.lowerBound + delta)..<(chip.range.upperBound + delta)
            let candidates: [Range<Int>]
            if chip.range.upperBound <= prefix {
                candidates = [chip.range]
            } else if chip.range.lowerBound >= editEnd {
                candidates = [shifted]
            } else if prefix <= chip.range.lowerBound && chip.range.upperBound <= editEnd {
                // The edit's old span swallows the chip: it was deleted or
                // replaced. When identical text sits beside it the diff may
                // name the wrong copy, but the result is the same text with
                // one binding fewer either way.
                candidates = []
            } else {
                // The edit cuts the chip's edge — typing inside it, or an
                // insert right at its start that the diff placed one
                // character in. Keep it only where `$name` still reads.
                candidates = [chip.range, shifted]
            }
            if let range = candidates.first(where: { Self.reads(next, range: $0, name: chip.name) }) {
                kept.append(Chip(name: chip.name, range: range))
            }
        }
        value.chips = Self.normalized(kept, length: next.count)
        return value
    }

    /// In range, in text order, and never overlapping — `payload` and the
    /// field's painting both rely on it.
    private static func normalized(_ chips: [Chip], length: Int) -> [Chip] {
        var out: [Chip] = []
        for chip in chips.sorted(by: { $0.range.lowerBound < $1.range.lowerBound })
        where chip.range.lowerBound >= 0 && chip.range.upperBound <= length {
            if let last = out.last, chip.range.lowerBound < last.range.upperBound { continue }
            out.append(chip)
        }
        return out
    }

    /// A deletion widened to whole chips, so backspace never leaves half of
    /// one behind.
    public func deletion(expanding range: NSRange) -> NSRange {
        var lower = range.location, upper = NSMaxRange(range)
        for chip in chips where chip.range.lowerBound < upper && lower < chip.range.upperBound {
            lower = min(lower, chip.range.lowerBound)
            upper = max(upper, chip.range.upperBound)
        }
        return NSRange(location: lower, length: upper - lower)
    }

    /// The chip ranges for painting the field.
    public var ranges: [NSRange] {
        chips.map { NSRange(location: $0.range.lowerBound, length: $0.range.count) }
    }

    /// What `submit` / `createConversation` send: the text with each chip
    /// kept apart from neighbouring word characters (so the bubble's
    /// lexical match finds it), and the picked names deduplicated in text
    /// order — `[]` with no picks, nil before 5.16, where the host would
    /// not know the argument and matches the text itself.
    public func payload(hostMinor: UInt32) -> (text: String, skills: [String]?) {
        let units = Array(text.utf16)
        var out: [UInt16] = []
        var cursor = 0
        var names: [String] = []
        // Skips anything out of order or out of range rather than building
        // a reversed slice, should the ordering ever break.
        for chip in chips where chip.range.lowerBound >= cursor && chip.range.upperBound <= units.count {
            out.append(contentsOf: units[cursor..<chip.range.lowerBound])
            if let last = out.last, !isWhitespace(last) { out.append(0x20) }
            out.append(contentsOf: units[chip.range])
            cursor = chip.range.upperBound
            if cursor < units.count, blocksMention(units, at: cursor) { out.append(0x20) }
            if !names.contains(chip.name) { names.append(chip.name) }
        }
        out.append(contentsOf: units[cursor...])
        let serialized = String(decoding: out, as: UTF16.self)
        guard hostSupportsFeature(hostMinor: hostMinor, feature: .boundSkills) else {
            return (serialized, nil)
        }
        return (serialized, names)
    }

    private static func reads(_ units: [UInt16], range: Range<Int>, name: String) -> Bool {
        guard range.lowerBound >= 0, range.upperBound <= units.count else { return false }
        return Array(units[range]) == Array(("$" + name).utf16)
    }
}

private func isWhitespace(_ unit: UInt16) -> Bool {
    guard let scalar = Unicode.Scalar(unit) else { return false }
    return CharacterSet.whitespacesAndNewlines.contains(scalar)
}

/// What may not follow a name for the core's matcher to see it: a letter,
/// number, `_` or `$`, or a `-`, since names read as `[a-z0-9-]+`.
private func blocksMention(_ units: [UInt16], at index: Int) -> Bool {
    var iterator = units[index...].makeIterator()
    var decoder = UTF16()
    guard case .scalarValue(let scalar) = decoder.decode(&iterator) else { return false }
    return scalar.properties.isAlphabetic || scalar.properties.numericType != nil
        || scalar == "_" || scalar == "$" || scalar == "-"
}
