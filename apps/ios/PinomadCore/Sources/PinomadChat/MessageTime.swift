import Foundation

/// One message instant, formatted for the transcript (the Web's
/// `chat-time.ts`): today shows only the time, another day this year adds
/// the date, another year adds the year. The full stamp stays available for
/// accessibility and the hover/long-press detail.
public struct MessageTime: Equatable, Sendable {
    /// The row's inline text.
    public let label: String
    /// The complete localized date and time.
    public let full: String
    /// ISO 8601, for metadata that wants a machine-readable instant.
    public let iso: String

    public init?(
        timestamp: Double,
        today: Date,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) {
        guard timestamp.isFinite else { return nil }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        guard date.timeIntervalSince1970.isFinite else { return nil }

        let sameDay = calendar.isDate(date, inSameDayAs: today)
        let sameYear = calendar.component(.year, from: date)
            == calendar.component(.year, from: today)
        let time = Self.format(date, template: "j:mm", calendar: calendar, locale: locale)
        if sameDay {
            label = time
        } else if sameYear {
            label = Self.format(date, template: "MMM d", calendar: calendar, locale: locale)
                + ", " + time
        } else {
            label = Self.format(date, template: "y MMM d", calendar: calendar, locale: locale)
                + ", " + time
        }
        full = Self.format(date, dateStyle: .full, timeStyle: .long,
                           calendar: calendar, locale: locale)
        iso = Self.iso(from: date)
    }

    private static func format(
        _ date: Date,
        template: String,
        calendar: Calendar,
        locale: Locale
    ) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.dateFormat = DateFormatter.dateFormat(
            fromTemplate: template, options: 0, locale: locale)
        return formatter.string(from: date)
    }

    private static func format(
        _ date: Date,
        dateStyle: DateFormatter.Style,
        timeStyle: DateFormatter.Style,
        calendar: Calendar,
        locale: Locale
    ) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.dateStyle = dateStyle
        formatter.timeStyle = timeStyle
        return formatter.string(from: date)
    }

    private static func iso(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}

/// The local start of today, shared by the transcript so every row crosses
/// midnight together. The view drives `refresh` from a timer at midnight and
/// from the scene becoming active again; a suspended app does not keep a
/// timer alive, so foreground is the authoritative wake-up.
public struct MessageClock: Equatable, Sendable {
    public private(set) var today: Date
    private let calendar: Calendar

    public init(now: Date = .now, calendar: Calendar = .current) {
        self.calendar = calendar
        self.today = calendar.startOfDay(for: now)
    }

    /// Re-read the calendar day. True only when the day actually moved, so
    /// the transcript re-renders once at midnight rather than every tick.
    @discardableResult
    public mutating func refresh(now: Date = .now) -> Bool {
        let next = calendar.startOfDay(for: now)
        guard next != today else { return false }
        today = next
        return true
    }

    public func time(for timestamp: Double?) -> MessageTime? {
        guard let timestamp else { return nil }
        return MessageTime(timestamp: timestamp, today: today, calendar: calendar)
    }
}
