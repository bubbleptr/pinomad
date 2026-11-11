import Foundation
import PinomadCore

/// What the overview's context grid and its legend read. The core already
/// matched the host's breakdown to the reply the meter counts
/// (`matchingBreakdown`); this turns it into the cells and the rows — the
/// web's `ContextBar` and `ContextBreakdownList`, nothing re-counted.
public struct ContextBreakdownReading: Equatable, Sendable {
    /// The meter's grid: each cell is 1/160 of the window.
    public static let columns = 32
    public static let cellCount = columns * 5

    /// The parts in the web's order (its `PARTS`).
    public enum Part: String, CaseIterable, Sendable {
        case system, tools, skills, mcp, messages

        public var label: String {
            switch self {
            case .system: "System"
            case .tools: "Tools"
            case .skills: "Skills"
            case .mcp: "MCP"
            case .messages: "Messages"
            }
        }
    }

    /// What colours a filled cell: a part of the breakdown, or without one
    /// the usage as a whole.
    public enum Fill: Equatable, Sendable {
        case used
        case part(Part)
    }

    public struct Row: Equatable, Sendable, Identifiable {
        /// Nil for what is left of the window (the empty cells).
        public let part: Part?
        public var id: String { part?.rawValue ?? "left" }
        public var label: String { part?.label ?? "Left" }
        /// Its tokens, e.g. "8k".
        public let figure: String
    }

    /// The filled cells from the grid's start; the rest of the grid is empty.
    public let cells: [Fill]

    /// One per part that takes space (zero parts, like no MCP servers, get
    /// none), then what is left of the window. Without a breakdown only the
    /// left row shows; at or past the window it is gone.
    public let rows: [Row]

    /// Unknown usage, by the meter's bounds, has no cells and no rows.
    public init(_ usage: ContextUsage?, breakdown: ContextBreakdown?) {
        guard let usage, ContextMeterReading.isKnown(used: usage.used, window: usage.window) else {
            cells = []
            rows = []
            return
        }
        // A part is at most the reply it belongs to; that also keeps an
        // absurd count out of the allocation.
        let parts: [(fill: Fill, tokens: Double)] = breakdown.map { breakdown in
            Part.allCases.compactMap { part in
                let tokens = breakdown[part]
                guard tokens.isFinite, tokens > 0, tokens <= breakdown.used else { return nil }
                return (.part(part), tokens)
            }
        } ?? [(.used, usage.used)]
        let counts = Self.allocateCells(parts.map(\.tokens), used: usage.used, window: usage.window)
        cells = zip(parts, counts).flatMap { part, count in Array(repeating: part.fill, count: count) }

        var rows: [Row] = parts.compactMap { part in
            guard case .part(let key) = part.fill else { return nil }
            return Row(part: key, figure: ContextMeterReading.formatTokens(part.tokens))
        }
        if usage.used < usage.window {
            rows.append(Row(part: nil, figure: ContextMeterReading.formatTokens(usage.window - usage.used)))
        }
        self.rows = rows
    }

    /// Cells per part on the window's scale, in the parts' order (the web's
    /// `allocateCells`). Every part that takes space gets at least one cell,
    /// so a 1M window still shows what fills a short conversation; the grid
    /// is full only once the window is, and past it the parts share the
    /// whole grid. Counts must be finite, and `used` and `window` known.
    static func allocateCells(_ tokens: [Double], used: Double, window: Double) -> [Int] {
        let present = tokens.count { $0 > 0 }
        guard present > 0 else { return tokens.map { _ in 0 } }
        let target = used >= window
            ? cellCount
            : max(present, min(cellCount - 1, Int((used / window * Double(cellCount)).rounded())))
        let total = tokens.reduce(0) { $0 + max(0, $1) }
        let quotas = tokens.map { $0 > 0 ? $0 / total * Double(target) : 0 }
        var cells = quotas.map { $0 > 0 ? max(1, Int($0)) : 0 }
        var missing = target - cells.reduce(0, +)
        // Largest remainder hands out what flooring left; the one-cell
        // minimum is paid back by the most over-served parts.
        while missing != 0 {
            let step = missing.signum()
            let gap = { (index: Int) in quotas[index] - Double(cells[index]) }
            let candidates = cells.indices.filter { quotas[$0] > 0 && (step > 0 || cells[$0] > 1) }
            // The first of equals, like the web's strict comparison.
            guard let pick = candidates.min(by: { step > 0 ? gap($0) > gap($1) : gap($0) < gap($1) }) else { break }
            cells[pick] += step
            missing -= step
        }
        return cells
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
