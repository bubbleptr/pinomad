import Foundation
import Testing
@testable import PinomadChat

private let utc = TimeZone(identifier: "UTC")!
private let locale = Locale(identifier: "en_US")

private func calendar() -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = utc
    return calendar
}

private func date(_ value: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = utc
    return formatter.date(from: value)!
}

/// DateFormatter separates the day period with a narrow no-break space.
private func normalized(_ label: String?) -> String? {
    label?.replacingOccurrences(of: "\u{202F}", with: " ")
}

@Suite struct MessageTimeTests {
    @Test func todayShowsOnlyTheTime() {
        let time = MessageTime(
            timestamp: date("2026-10-27T14:31:00Z").timeIntervalSince1970 * 1000,
            today: date("2026-10-27T20:00:00Z"),
            calendar: calendar(),
            locale: locale
        )
        #expect(normalized(time?.label) == "2:31 PM")
        #expect(time?.full.contains("October 27, 2026") == true)
        #expect(time?.iso == "2026-10-27T14:31:00Z")
    }

    @Test func anotherDayThisYearAddsTheDate() {
        let time = MessageTime(
            timestamp: date("2026-10-27T14:31:00Z").timeIntervalSince1970 * 1000,
            today: date("2026-10-28T09:00:00Z"),
            calendar: calendar(),
            locale: locale
        )
        #expect(normalized(time?.label) == "Oct 27, 2:31 PM")
    }

    @Test func anotherYearAddsTheYear() {
        let time = MessageTime(
            timestamp: date("2025-10-27T14:31:00Z").timeIntervalSince1970 * 1000,
            today: date("2026-01-02T09:00:00Z"),
            calendar: calendar(),
            locale: locale
        )
        #expect(normalized(time?.label) == "Oct 27, 2025, 2:31 PM")
    }

    @Test func malformedStampsHaveNoTime() {
        #expect(MessageTime(timestamp: .nan, today: date("2026-10-27T20:00:00Z"), calendar: calendar(), locale: locale) == nil)
        #expect(MessageTime(timestamp: .infinity, today: date("2026-10-27T20:00:00Z"), calendar: calendar(), locale: locale) == nil)
    }
}

@Suite struct MessageClockTests {
    @Test func crossingMidnightRelabelsYesterday() {
        var clock = MessageClock(now: date("2026-10-27T23:59:00Z"), calendar: calendar())
        let stamp = date("2026-10-27T23:58:00Z").timeIntervalSince1970 * 1000
        #expect(normalized(clock.time(for: stamp)?.label) == "11:58 PM")

        #expect(clock.refresh(now: date("2026-10-28T00:01:00Z")) == true)
        #expect(normalized(clock.time(for: stamp)?.label) == "Oct 27, 11:58 PM")
    }

    @Test func theSameDayIsNotAChange() {
        var clock = MessageClock(now: date("2026-10-27T09:00:00Z"), calendar: calendar())
        #expect(clock.refresh(now: date("2026-10-27T23:00:00Z")) == false)
    }

    @Test func foregoundRefreshPicksTheNewDay() {
        var clock = MessageClock(now: date("2026-10-27T09:00:00Z"), calendar: calendar())
        // A suspended app wakes after midnight: the next foreground read moves
        // the day even though no timer fired in between.
        #expect(clock.refresh(now: date("2026-10-29T08:00:00Z")) == true)
        #expect(clock.today == calendar().startOfDay(for: date("2026-10-29T08:00:00Z")))
    }
}
