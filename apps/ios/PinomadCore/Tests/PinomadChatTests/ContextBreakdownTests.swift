import PinomadCore
import Testing
@testable import PinomadChat

@Suite struct ContextBreakdownReadingTests {
    private let parts = ContextBreakdown(
        used: 124_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 0, messages: 100_700
    )

    /// Same rows and figures as the web's Usage section.
    @Test func listsEachPartThatTakesSpace() {
        let reading = ContextBreakdownReading(parts, window: 200_000)!
        #expect(reading.rows.map(\.label) == ["System", "Skills", "Tools", "Messages"])
        #expect(reading.rows.map(\.figure) == ["8k · 4%", "3k · 2%", "12k · 6%", "101k · 50%"])
        #expect(reading.rows.map(\.fraction) == [0.0405, 0.016, 0.06, 0.5035])
    }

    /// After a swap to a smaller model the bar fills to the total and the
    /// shares pass 100% together, like the ring's honest percent.
    @Test func overWindowScalesTheBarToTheTotal() {
        let over = ContextBreakdown(used: 250_000, system: 50_000, skills: 0, tools: 0, mcp: 0, messages: 200_000)
        let reading = ContextBreakdownReading(over, window: 200_000)!
        #expect(reading.rows.map(\.fraction) == [0.2, 0.8])
        #expect(reading.rows.map(\.figure) == ["50k · 25%", "200k · 100%"])
    }

    @Test func nothingToShowWithoutABreakdownOrAScale() {
        #expect(ContextBreakdownReading(nil, window: 200_000) == nil)
        #expect(ContextBreakdownReading(parts, window: nil) == nil)
        #expect(ContextBreakdownReading(parts, window: 0) == nil)
    }

    /// A provider can report counts beyond any real window; the shares must
    /// not trap converting to Int. Like the meter, such a reading is unknown.
    @Test func absurdCountsReadAsNothingToShow() {
        let absurd = ContextBreakdown(used: 1e25, system: 8_100, skills: 0, tools: 0, mcp: 0, messages: 1e25)
        #expect(ContextBreakdownReading(absurd, window: 200_000) == nil)
        #expect(ContextBreakdownReading(parts, window: 1e25) == nil)
    }
}
