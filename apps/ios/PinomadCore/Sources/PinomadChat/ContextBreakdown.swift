import Foundation
import PinomadCore

/// What the overview's breakdown rows read. The core already matched the
/// host's breakdown to the reply the meter counts (`matchingBreakdown`); this
/// turns it into the rows, bar shares, and figures — the web's
/// `ContextBreakdownList`, nothing re-counted.
public struct ContextBreakdownReading: Equatable, Sendable {
    /// The parts in the web's order and colors (its `--pigui-data-*` palette).
    public enum Part: String, CaseIterable, Sendable {
        case system, skills, tools, mcp, messages

        public var label: String {
            switch self {
            case .system: "System"
            case .skills: "Skills"
            case .tools: "Tools"
            case .mcp: "MCP"
            case .messages: "Messages"
            }
        }
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public let part: Part
        public var id: Part { part }
        public var label: String { part.label }
        /// This part's length on the bar, from 0 to 1.
        public let fraction: Double
        /// Tokens and share of the window, e.g. "8k · 4%".
        public let figure: String
    }

    /// One per part that takes space; zero parts (no MCP servers) get none.
    public let rows: [Row]

    /// Nil without a breakdown or a window to scale it — the row then stays
    /// the meter alone. Past the window (a swap to a smaller model) the bar
    /// scales to the total so it still fills, while the shares stay honest.
    public init?(_ breakdown: ContextBreakdown?, window: Double?) {
        // The meter's bounds: an absurd provider count reads as unknown rather
        // than trapping the share's Int conversion. Every part is at most
        // `used`, so bounding `used` bounds them all.
        let limit = ContextMeterReading.maxTokens
        guard let breakdown, let window, window.isFinite, window >= 1, window < limit,
              breakdown.used.isFinite, breakdown.used >= 0, breakdown.used < limit else { return nil }
        let scale = max(window, breakdown.used)
        rows = Part.allCases.compactMap { part in
            let tokens = breakdown[part]
            guard tokens.isFinite, tokens > 0, tokens <= breakdown.used else { return nil }
            return Row(
                part: part,
                fraction: tokens / scale,
                figure: "\(ContextMeterReading.formatTokens(tokens)) · \(Int((tokens / window * 100).rounded()))%"
            )
        }
    }
}

private extension ContextBreakdown {
    subscript(part: ContextBreakdownReading.Part) -> Double {
        switch part {
        case .system: system
        case .skills: skills
        case .tools: tools
        case .mcp: mcp
        case .messages: messages
        }
    }
}
