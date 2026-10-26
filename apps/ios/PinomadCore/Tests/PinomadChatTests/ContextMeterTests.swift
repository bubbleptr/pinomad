import Testing
@testable import PinomadChat

@Suite struct ContextMeterReadingTests {
    @Test func readsTheShareAndFigures() {
        let reading = ContextMeterReading(used: 84_000, window: 200_000)
        #expect(reading.percent == 42)
        #expect(reading.fill == 0.42)
        #expect(reading.detail == "42% · 84k / 200k")
        #expect(reading.accessibilityLabel == "Context 42% used, 84k of 200k tokens")
        #expect(reading.warning == false)
    }

    @Test func warnsFromTheDisplayedEightyPercent() {
        #expect(ContextMeterReading(used: 160, window: 200).warning)
        #expect(ContextMeterReading(used: 158, window: 200).warning == false)
        // 79.5% rounds to the 80% the reader sees, so the colour follows it.
        #expect(ContextMeterReading(used: 159, window: 200).warning)
    }

    /// A swap to a smaller model can push used past the window: the
    /// popover's percent stays honest while the ring saturates.
    @Test func overflowKeepsTheHonestPercentAndFillsTheRing() {
        let reading = ContextMeterReading(used: 240_000, window: 200_000)
        #expect(reading.percent == 120)
        #expect(reading.detail == "120% · 240k / 200k")
        #expect(reading.fill == 1)
        #expect(reading.warning)
    }

    @Test func formatsMillionsWithOneDecimal() {
        #expect(ContextMeterReading.formatTokens(1_200_000) == "1.2M")
        #expect(ContextMeterReading.formatTokens(1_250_000) == "1.3M")
        #expect(ContextMeterReading.formatTokens(1_000_000) == "1M")
        #expect(ContextMeterReading.formatTokens(999_999) == "1000k")
        #expect(ContextMeterReading.formatTokens(42) == "42")
    }

    /// A provider can report counts beyond any real window. Converting
    /// them for the percent or the figures must fall back, not trap.
    @Test func absurdCountsFallBackInsteadOfTrapping() {
        let huge = ContextMeterReading(used: 1e308, window: 200_000)
        #expect(huge.percent == nil)
        #expect(huge.detail == "No usage data yet")

        // A sub-token window divides up instead of down; it is no scale.
        let tinyWindow = ContextMeterReading(used: 1, window: 1e-300)
        #expect(tinyWindow.percent == nil)

        #expect(ContextMeterReading.formatTokens(1e308) == "—")
    }

    @Test func noUsageLeavesTheGaugeEmpty() {
        let reading = ContextMeterReading(nil)
        #expect(reading.percent == nil)
        #expect(reading.fill == 0)
        #expect(reading.warning == false)
        #expect(reading.detail == "No usage data yet")
        #expect(reading.accessibilityLabel == "Context usage unknown")
    }
}
