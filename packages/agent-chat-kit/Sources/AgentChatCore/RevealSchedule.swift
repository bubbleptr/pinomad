/// When each piece of streamed text should appear. Tokens arrive in bursts;
/// shown as they come, a reply jerks forward. Instead every burst is spread
/// evenly, a word at a time, over the catch-up window that follows it, so
/// the text flows at an even pace and never trails what arrived by more than
/// that window.
public struct RevealSchedule: Sendable {
    public struct Pace: Sendable, Equatable {
        /// The most the shown text may trail the arrived text, in seconds.
        public var catchUp: Double
        /// How long a revealed word takes to fade in, in seconds.
        public var fade: Double

        public init(catchUp: Double, fade: Double) {
            self.catchUp = catchUp
            self.fade = fade
        }

        public static let standard = Pace(catchUp: 0.25, fade: 0.5)
    }

    public let pace: Pace
    /// UTF-8 end offset of each unit and when it appears, both ascending.
    private var ends: [Int] = []
    private var times: [Double] = []
    private var arrived = 0

    public init(pace: Pace = .standard) {
        self.pace = pace
    }

    /// Text that arrived at `time`, in seconds on the caller's clock.
    public mutating func append(_ text: String, at time: Double) {
        let units = Self.unitEnds(of: text, from: arrived)
        arrived += text.utf8.count
        guard !units.isEmpty else { return }

        let start = max(time, times.last ?? time)
        let end = max(start, time + pace.catchUp)
        for (index, unitEnd) in units.enumerated() {
            ends.append(unitEnd)
            times.append(start + (end - start) * Double(index) / Double(units.count))
        }
    }

    /// UTF-8 length of the text shown at `time`.
    public func revealedLength(at time: Double) -> Int {
        guard let index = lastIndex(revealedBy: time) else { return 0 }
        return ends[index]
    }

    /// When the next unit after those shown at `time` appears; nil when all arrived text is shown.
    public func nextReveal(after time: Double) -> Double? {
        let next = (lastIndex(revealedBy: time) ?? -1) + 1
        return next < times.count ? times[next] : nil
    }

    /// The units revealed within `window` seconds before `time`, latest
    /// first, as UTF-8 ranges with the time each appeared.
    public func recentReveals(at time: Double, within window: Double) -> [(range: Range<Int>, time: Double)] {
        guard var index = lastIndex(revealedBy: time) else { return [] }
        var result: [(range: Range<Int>, time: Double)] = []
        while index >= 0, time - times[index] < window {
            result.append(((index > 0 ? ends[index - 1] : 0)..<ends[index], times[index]))
            index -= 1
        }
        return result
    }

    private func lastIndex(revealedBy time: Double) -> Int? {
        var low = 0
        var high = times.count
        while low < high {
            let mid = (low + high) / 2
            if times[mid] <= time { low = mid + 1 } else { high = mid }
        }
        return low == 0 ? nil : low - 1
    }

    /// Splits text into units: a word with the whitespace after it, or a single
    /// ideograph, since CJK text has no spaces to split on. Whitespace opening
    /// the text goes with its first word, so nothing shows before it arrives.
    private static func unitEnds(of text: String, from base: Int) -> [Int] {
        var ends: [Int] = []
        var offset = base
        var inWord = false
        for character in text {
            let ideograph = character.unicodeScalars.first?.properties.isIdeographic == true
            if character.isWhitespace {
                if !ends.isEmpty { ends[ends.count - 1] = offset + character.utf8.count }
                inWord = false
            } else if ideograph || !inWord {
                ends.append(offset + character.utf8.count)
                inWord = !ideograph
            } else {
                ends[ends.count - 1] = offset + character.utf8.count
            }
            offset += character.utf8.count
        }
        // Leading whitespace with no unit before it in this text.
        if ends.isEmpty, offset > base { ends.append(offset) }
        return ends
    }
}
