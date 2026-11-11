import PinomadCore
import Testing
@testable import PinomadChat

@Suite struct ContextBreakdownReadingTests {
    private typealias Reading = ContextBreakdownReading

    private let usage = ContextUsage(used: 124_000, window: 200_000)
    private let parts = ContextBreakdown(
        used: 124_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 0, messages: 100_700
    )

    // MARK: Cell allocation (the web's `allocateCells` cases)

    @Test func everyPartThatTakesSpaceGetsACellEvenOnAHugeWindow() {
        // 24k of a 1M window: each part is under a cell's worth on its own.
        let cells = Reading.allocateCells([12_000, 3_000, 4_000, 0, 5_000], used: 24_000, window: 1_000_000)
        #expect(cells.map { $0 > 0 } == [true, true, true, false, true])
    }

    @Test func aTinyReadingStaysVisibleButSmall() {
        #expect(Reading.allocateCells([1_500, 500], used: 2_000, window: 1_000_000) == [1, 1])
    }

    @Test func followsTheWindowsScaleAndThePartsProportions() {
        let cells = Reading.allocateCells([21_000, 63_000], used: 84_000, window: 200_000)
        #expect(cells.reduce(0, +) == 67) // 42% of 160
        #expect(Double(cells[1]) > Double(cells[0]) * 2.5)
    }

    @Test func leavesACellEmptyUntilTheWindowIsActuallyFull() {
        #expect(Reading.allocateCells([199_500], used: 199_500, window: 200_000) == [Reading.cellCount - 1])
    }

    @Test func fillsTheGridExactlyAtOrPastTheWindow() {
        #expect(Reading.allocateCells([200_000], used: 200_000, window: 200_000) == [Reading.cellCount])
        let over = Reading.allocateCells([50_000, 200_000], used: 250_000, window: 200_000)
        #expect(over.reduce(0, +) == Reading.cellCount)
    }

    // MARK: Grid and legend

    /// The grid's colours and the legend run in the same order, the web's.
    @Test func gridAndLegendFollowThePartOrder() {
        let all = ContextBreakdown(used: 100_000, system: 10_000, skills: 10_000, tools: 10_000, mcp: 10_000, messages: 60_000)
        let reading = Reading(ContextUsage(used: 100_000, window: 200_000), breakdown: all)
        let order: [Reading.Part] = [.system, .tools, .skills, .mcp, .messages]
        #expect(reading.rows.map(\.part) == order + [nil])
        var seen: [Reading.Fill] = []
        for cell in reading.cells where seen.last != cell { seen.append(cell) }
        #expect(seen == order.map(Reading.Fill.part))
        #expect(reading.cells.count == 80)
    }

    /// A row per part that takes space with its tokens alone, then what is left.
    @Test func legendListsTokensOnlyThenWhatIsLeft() {
        let reading = Reading(usage, breakdown: parts)
        #expect(reading.rows.map(\.label) == ["System", "Tools", "Skills", "Messages", "Left"])
        #expect(reading.rows.map(\.figure) == ["8k", "12k", "3k", "101k", "76k"])
    }

    /// An older host, or a reply not broken down yet: one fill and the Left row.
    @Test func withoutABreakdownOneFillAndTheLeftRow() {
        let reading = Reading(usage, breakdown: nil)
        #expect(reading.cells == Array(repeating: .used, count: 99)) // 62% of 160
        #expect(reading.rows.map(\.label) == ["Left"])
        #expect(reading.rows.map(\.figure) == ["76k"])
    }

    @Test func nothingIsLeftAtOrPastTheWindow() {
        let full = Reading(ContextUsage(used: 200_000, window: 200_000), breakdown: nil)
        #expect(full.rows.isEmpty)
        #expect(full.cells.count == Reading.cellCount)

        let over = ContextBreakdown(used: 250_000, system: 50_000, skills: 0, tools: 0, mcp: 0, messages: 200_000)
        let reading = Reading(ContextUsage(used: 250_000, window: 200_000), breakdown: over)
        #expect(reading.rows.map(\.label) == ["System", "Messages"])
        #expect(reading.cells.count == Reading.cellCount)
    }

    @Test func unknownUsageShowsAnEmptyGridAndNoLegend() {
        for usage in [nil, ContextUsage(used: 124_000, window: 0)] {
            let reading = Reading(usage, breakdown: parts)
            #expect(reading.cells.isEmpty)
            #expect(reading.rows.isEmpty)
        }
    }

    /// A provider can report counts beyond any real window; the allocation
    /// must not trap converting to Int. Like the meter, such a reading is unknown.
    @Test func absurdCountsReadAsUnknown() {
        let absurd = ContextBreakdown(used: 1e25, system: 8_100, skills: 0, tools: 0, mcp: 0, messages: 1e25)
        for usage in [ContextUsage(used: 1e25, window: 200_000), ContextUsage(used: 124_000, window: 1e25)] {
            let reading = Reading(usage, breakdown: absurd)
            #expect(reading.cells.isEmpty)
            #expect(reading.rows.isEmpty)
        }
        // A part the reply cannot hold is dropped, not drawn.
        let impossible = ContextBreakdown(used: 124_000, system: .nan, skills: 0, tools: 1e25, mcp: 0, messages: 100_000)
        #expect(Reading(usage, breakdown: impossible).rows.map(\.label) == ["Messages", "Left"])
    }
}
