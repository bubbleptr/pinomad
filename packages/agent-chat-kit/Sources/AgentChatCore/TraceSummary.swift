import Foundation

/// How a trace's work reads in one line: the capsule's settled label and
/// the clock and counts that follow any label.
public struct TraceSummary: Sendable, Equatable {
    public enum Headline: Sendable, Hashable {
        case thinking
        /// Making tool calls.
        case working
        /// Done, without calling a tool.
        case thought
        case worked
        case failed
        case interrupted
    }

    public var headline: Headline
    /// Whole seconds; ticks while the agent works, then stops. The live
    /// clock floors, while a settled duration rounds and reads at least 1s.
    public var elapsed: Duration?
    /// Calls the model made itself; calls made from inside a tool are not counted.
    public var toolCount: Int
    public var failedToolCount: Int
}

extension AgentTrace {
    public func summary(at now: Date) -> TraceSummary {
        let calls = steps.flatMap { step -> [ToolCall] in
            if case let .tools(_, calls) = step { calls } else { [] }
        }
        let working = phase == .thinking || phase == .acting

        let headline: TraceSummary.Headline
        switch (outcome, phase) {
        case (.failed, _): headline = .failed
        case (.interrupted, _): headline = .interrupted
        case (_, .thinking): headline = .thinking
        case (_, .acting): headline = .working
        default: headline = calls.isEmpty ? .thought : .worked
        }

        let end = working ? now : endedAt
        let elapsed = startedAt.flatMap { start in
            end.map { stop in
                let measured = max(stop.timeIntervalSince(start), 0)
                // Floor the live clock so it never shows a second early or
                // claims 1s at the start. Once settled, match the web:
                // round and never read as 0s.
                let seconds = working ? Int(measured) : max(1, Int(measured.rounded()))
                return Duration.seconds(seconds)
            }
        }
        return TraceSummary(
            headline: headline,
            elapsed: elapsed,
            toolCount: calls.count,
            failedToolCount: calls.count { $0.state == .failed }
        )
    }
}

extension TraceSummary {
    /// The clock as it reads after a label: "2s", "1m 0s", "1h 2m 3s" in
    /// English. It starts at the largest unit the duration reaches and shows
    /// every smaller one, zeros included, so the fields keep their places
    /// as it ticks.
    public static func clockText(_ elapsed: Duration, locale: Locale = .autoupdatingCurrent) -> String {
        clockFields(elapsed, locale: locale).joined()
    }

    /// The clock's fields, largest unit first, each carrying the separator
    /// that follows it: ["1m ", "0s"] in English, ["1分钟", "0秒"] in Chinese.
    /// A live clock rolls each field on its own, so a unit appearing at 60s
    /// doesn't shift the seconds' letters into the roll.
    public static func clockFields(_ elapsed: Duration, locale: Locale = .autoupdatingCurrent) -> [String] {
        let total = max(0, elapsed.components.seconds)
        // Each field's own seconds, so formatting it in its one unit reads whole.
        let parts: [(Int64, Duration.UnitsFormatStyle.Unit)] = total >= 3_600
            ? [(total / 3_600 * 3_600, .hours), (total % 3_600 / 60 * 60, .minutes), (total % 60, .seconds)]
            : total >= 60 ? [(total / 60 * 60, .minutes), (total % 60, .seconds)] : [(total, .seconds)]
        let style = { (unit: Duration.UnitsFormatStyle.Unit) in
            Duration.UnitsFormatStyle(allowedUnits: [unit], width: .narrow, zeroValueUnits: .show(length: 1)).locale(locale)
        }
        let fields = parts.map { Duration.seconds($0.0).formatted(style($0.1)) }
        // Whether the locale spaces its fields ("1m 0s") or runs them together ("1分钟0秒").
        let whole = Duration.seconds(total).formatted(
            Duration.UnitsFormatStyle(allowedUnits: Set(parts.map(\.1)), width: .narrow, zeroValueUnits: .show(length: 1)).locale(locale)
        )
        let separator = whole == fields.joined() ? "" : " "
        return fields.enumerated().map { $0.offset < fields.count - 1 ? $0.element + separator : $0.element }
    }
}
