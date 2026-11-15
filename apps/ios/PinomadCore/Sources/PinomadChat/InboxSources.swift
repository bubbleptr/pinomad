import Foundation
import PinomadCore

// The Inbox settings' event sources (ADR-0051 §10) as data: the add form's
// checks and spec, a switch's flip until the snapshot catches up, and the
// guard that keeps a late reply off a sheet opened after it.

/// The add-source form. Checks what it can cheaply (empty fields, lengths,
/// a 24-hour time, a cron's five fields, a known zone); the host checks the
/// rest and its refusal shows in the form.
public struct InboxSourceForm: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable { case schedule, plugin, webhook }
    public enum Repeat: String, CaseIterable, Sendable { case daily, weekdays, weekly, cron }

    /// `INBOX_SOURCE_NAME_MAX` and friends in `packages/protocol/src/inbox.ts`.
    public static let nameMax = 120
    public static let noteMax = 4_000
    public static let filterMax = 500

    public var kind: Kind = .schedule
    public var name = ""
    public var note = ""
    public var repeatKind: Repeat = .daily
    /// 24-hour `HH:mm` whatever the device's locale.
    public var time = "09:00"
    /// 0 = Sunday.
    public var day = 1
    public var cron = ""
    public var zone: String
    public var plugin = ""
    public var event = ""
    public var filter = ""
    /// Plugin and webhook only: all tools, rather than restricted.
    public var trusted = false

    public struct Problems: Equatable, Sendable {
        public var name: String?
        public var note: String?
        public var time: String?
        public var cron: String?
        public var zone: String?
        public var filter: String?

        public init() {}

        public var isEmpty: Bool { [name, note, time, cron, zone, filter].allSatisfy { $0 == nil } }
    }

    /// Starts on the first plugin that declares sources, so Plugin opens filled in.
    public init(zone: String, plugins: [PluginInfo]) {
        self.zone = zone
        let first = Self.withSources(plugins).first
        plugin = first?.name ?? ""
        event = first?.sources.first?.name ?? ""
    }

    public static func withSources(_ plugins: [PluginInfo]) -> [PluginInfo] {
        plugins.filter { !$0.sources.isEmpty }
    }

    /// Picking another plugin picks its first source.
    public mutating func pick(plugin name: String, among plugins: [PluginInfo]) {
        plugin = name
        event = plugins.first { $0.name == name }?.sources.first?.name ?? ""
    }

    public func picked(among plugins: [PluginInfo]) -> PluginSourceInfo? {
        plugins.first { $0.name == plugin }?.sources.first { $0.name == event }
    }

    /// A schedule's note is the user's own words, so its tasks count as theirs.
    public var effectiveTrusted: Bool { kind == .schedule ? true : trusted }

    public var problems: Problems {
        var problems = Problems()
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            problems.name = "Give it a name"
        } else if name.count > Self.nameMax {
            problems.name = "At most \(Self.nameMax) characters"
        }
        if kind == .schedule {
            let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
            if note.isEmpty {
                problems.note = "Say what each task should do"
            } else if note.count > Self.noteMax {
                problems.note = "At most \(Self.noteMax) characters"
            }
            if repeatKind != .cron, !Self.isTime(time) { problems.time = "A 24-hour time, such as 08:30" }
            if repeatKind == .cron, cronFields.count != 5 {
                problems.cron = "Five fields: minute hour day-of-month month day-of-week"
            }
            if !Self.isZone(zone.trimmingCharacters(in: .whitespaces)) {
                problems.zone = "An IANA time zone, such as Europe/Berlin"
            }
        }
        if kind == .plugin, filter.trimmingCharacters(in: .whitespacesAndNewlines).count > Self.filterMax {
            problems.filter = "At most \(Self.filterMax) characters"
        }
        return problems
    }

    /// What `addInboxSource` sends; nil while the form has problems or no
    /// plugin source is picked.
    public func spec(plugins: [PluginInfo]) -> InboxSourceSpec? {
        guard problems.isEmpty else { return nil }
        switch kind {
        case .schedule:
            let timeZone = zone.trimmingCharacters(in: .whitespaces)
            let schedule: InboxSchedule = switch repeatKind {
            case .daily: .daily(time: time, timeZone: timeZone)
            case .weekdays: .weekdays(time: time, timeZone: timeZone)
            case .weekly: .weekly(day: UInt8(clamping: day), time: time, timeZone: timeZone)
            case .cron: .cron(expression: cronFields.joined(separator: " "), timeZone: timeZone)
            }
            return .schedule(schedule: schedule, note: note.trimmingCharacters(in: .whitespacesAndNewlines))
        case .plugin:
            guard let picked = picked(among: plugins) else { return nil }
            // A source that takes no filter gets none, whatever was typed.
            let filter = picked.filter == nil ? "" : filter.trimmingCharacters(in: .whitespacesAndNewlines)
            return .plugin(plugin: plugin, source: event, filter: filter)
        case .webhook:
            return .webhook
        }
    }

    private var cronFields: [String] {
        cron.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    public static func isTime(_ text: String) -> Bool {
        text.wholeMatch(of: /([01]\d|2[0-3]):[0-5]\d/) != nil
    }

    public static func isZone(_ zone: String) -> Bool {
        !zone.isEmpty && TimeZone(identifier: zone) != nil
    }
}

/// A switch flipped by the user, by source id: the switch shows the flip
/// until the snapshot leaves the value it was flipped from, or, once the
/// host has answered, until the next snapshot — so a later flip back from
/// another device shows as it is, not as this device asked.
public struct InboxSourceFlips: Equatable, Sendable {
    struct Flip: Equatable, Sendable {
        let from: Bool
        /// The snapshot version current when the host answered.
        var answeredAt: UInt64?
    }

    var flips: [String: Flip] = [:]

    public init() {}

    public mutating func begin(_ id: String, from: Bool) {
        flips[id] = Flip(from: from)
    }

    /// The host took it; the next snapshot after `version` is the truth.
    public mutating func answered(_ id: String, at version: UInt64) {
        flips[id]?.answeredAt = version
    }

    /// The host refused: the switch goes back to the snapshot.
    public mutating func failed(_ id: String) {
        flips[id] = nil
    }

    /// Drop the flips the snapshot has caught up with.
    public mutating func catchUp(_ sources: [InboxSource], version: UInt64) {
        flips = flips.filter { id, flip in
            guard let source = sources.first(where: { $0.id == id }), source.enabled == flip.from else { return false }
            return flip.answeredAt.map { version <= $0 } ?? true
        }
    }

    /// What the switch shows, and whether it waits on the host.
    public func shown(_ source: InboxSource) -> (isOn: Bool, busy: Bool) {
        guard let flip = flips[source.id], flip.from == source.enabled else { return (source.enabled, false) }
        return (!source.enabled, flip.answeredAt == nil)
    }
}

/// The one sheet a page shows, with a token per presentation: a reply that
/// arrives after its sheet was closed or replaced finds a different token
/// and is dropped, so it can neither close a newer sheet nor show an old
/// secret in it.
public struct LatestSheet<Value: Sendable>: Sendable {
    public private(set) var value: Value?
    public private(set) var token = 0

    public init() {}

    /// Show `value`; the returned token names this presentation.
    @discardableResult
    public mutating func present(_ value: Value) -> Int {
        token += 1
        self.value = value
        return token
    }

    public mutating func dismiss() {
        token += 1
        value = nil
    }

    public func isCurrent(_ token: Int) -> Bool {
        value != nil && token == self.token
    }

    /// Move the presentation `token` names on to `next` (nil closes it);
    /// false, and nothing changes, when it is no longer the one shown.
    @discardableResult
    public mutating func complete(_ token: Int, with next: Value?) -> Bool {
        guard isCurrent(token) else { return false }
        if let next { present(next) } else { dismiss() }
        return true
    }
}

/// The host's quiet hours are minutes after the host's local midnight; the
/// form edits them as 24-hour `HH:mm`, never through the device's zone.
public enum QuietHoursText {
    /// A fresh window: overnight.
    public static let fresh = QuietHours(start: 22 * 60, end: 8 * 60)

    public static func clock(_ minutes: UInt32) -> String {
        String(format: "%02d:%02d", minutes / 60 % 24, minutes % 60)
    }

    public static func minutes(_ text: String) -> UInt32? {
        guard InboxSourceForm.isTime(text) else { return nil }
        let parts = text.split(separator: ":").compactMap { UInt32($0) }
        return parts[0] * 60 + parts[1]
    }
}

extension Inbox {
    /// `path` with its top replaced by `next` only while the top is still
    /// `expected` — an answer that comes back after the reader moved on
    /// doesn't take them anywhere.
    public static func replacingTop<Route: Equatable>(_ path: [Route], ifTop expected: Route, with next: Route) -> [Route]? {
        guard path.last == expected else { return nil }
        return path.dropLast() + [next]
    }

    /// The composer draft for an intake that opened while the draft page
    /// still held unsent text: that text, after any draft the conversation
    /// already has. `nil` leaves the conversation's draft as it is.
    public static func carryingDraft(_ unsent: String, into existing: String?) -> String? {
        guard !unsent.allSatisfy(\.isWhitespace) else { return nil }
        guard let existing, !existing.allSatisfy(\.isWhitespace) else { return unsent }
        return existing + "\n\n" + unsent
    }
}
