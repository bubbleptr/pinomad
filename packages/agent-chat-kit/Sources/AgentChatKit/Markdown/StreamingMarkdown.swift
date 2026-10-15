import AgentChatCore
import Foundation
import Observation

/// A reply streaming in: append tokens as they arrive and it reveals them at
/// an even pace, a word at a time, each word fading in.
@MainActor @Observable
public final class StreamingMarkdown {
    /// The revealed part of the reply, as Markdown blocks.
    public private(set) var stream = MarkdownStream()
    /// Whether words are still revealing or fading in.
    public private(set) var isAnimating = false

    /// All the Markdown that has arrived, revealed or not.
    public var markdown: String { source }

    @ObservationIgnored private var source = ""
    @ObservationIgnored private var schedule: RevealSchedule
    @ObservationIgnored private let paced: Bool
    @ObservationIgnored private let origin = Date.now
    @ObservationIgnored private var shown = 0
    @ObservationIgnored private var arrivalFinished = false
    @ObservationIgnored private var pump: Task<Void, Never>?

    /// A nil pace shows text the moment it arrives.
    public init(pace: RevealSchedule.Pace? = .standard) {
        schedule = RevealSchedule(pace: pace ?? .standard)
        paced = pace != nil
    }

    /// A finished reply, shown at once.
    public convenience init(markdown: String) {
        self.init(pace: nil)
        append(markdown)
        finish()
    }

    public func append(_ text: String) {
        precondition(!arrivalFinished, "append after finish")
        source += text
        if paced {
            schedule.append(text, at: seconds(.now))
            startPump()
        } else {
            reveal(upTo: source.utf8.count)
        }
    }

    /// No more text is coming; what has not been revealed yet still will be.
    public func finish() {
        arrivalFinished = true
        reveal(upTo: shown)
    }

    /// Opacity of the last revealed characters, the last one first; empty once
    /// everything has faded in. Markdown punctuation is skipped, since it
    /// does not show.
    func tailOpacities(at date: Date) -> [Double] {
        let time = seconds(date)
        let fade = schedule.pace.fade
        let reveals = schedule.recentReveals(at: time, within: fade)
        guard let oldest = reveals.last?.range.lowerBound else { return [] }

        var opacities: [Double] = []
        var unit = 0
        var offset = shown
        for character in source.utf8Prefix(shown).reversed() {
            offset -= character.utf8.count
            if offset < oldest || opacities.count >= 400 { break }
            while unit < reveals.count - 1, offset < reveals[unit].range.lowerBound { unit += 1 }
            if "*_`~#>|\n\r".contains(character) { continue }
            opacities.append(min(max((time - reveals[unit].time) / fade, 0), 1))
        }
        return opacities
    }

    private func seconds(_ date: Date) -> Double {
        date.timeIntervalSince(origin)
    }

    private func reveal(upTo target: Int) {
        if target > shown {
            stream.append(String(source.utf8Prefix(target).utf8Dropping(shown)))
            shown = target
        }
        if arrivalFinished, shown == source.utf8.count, !stream.isFinished {
            stream.finish()
        }
    }

    private func startPump() {
        guard pump == nil else { return }
        isAnimating = true
        pump = Task { [weak self] in
            while let self {
                let now = seconds(.now)
                reveal(upTo: schedule.revealedLength(at: now))
                if let next = schedule.nextReveal(after: now) {
                    try? await Task.sleep(for: .seconds(max(next - now, 0.001)))
                } else if !schedule.recentReveals(at: now, within: schedule.pace.fade).isEmpty {
                    // Last words still fading; keep watching for new text meanwhile.
                    try? await Task.sleep(for: .milliseconds(50))
                } else {
                    break
                }
            }
            self?.pump = nil
            self?.isAnimating = false
        }
    }
}

private extension String {
    func utf8Prefix(_ length: Int) -> Substring {
        self[..<utf8.index(startIndex, offsetBy: length)]
    }
}

private extension Substring {
    func utf8Dropping(_ length: Int) -> Substring {
        self[utf8.index(startIndex, offsetBy: length)...]
    }
}
