import PinomadCore

/// The thinking level the reader picked, kept across model switches: a
/// model without it runs at the nearest level below, and switching to one
/// that has it puts it back (as on web).
public enum LevelIntent {
    /// The level to set after switching to a model with `levels`, or nil
    /// when the host's own clamp of `current` already lands there.
    public static func afterSwitch(levels: [ThinkingLevel], intent: ThinkingLevel,
                                   current: ThinkingLevel) -> ThinkingLevel? {
        let levels = levels.isEmpty ? [.off] : levels
        let want = clampLevel(levels: levels, want: intent)
        return want == clampLevel(levels: levels, want: current) ? nil : want
    }
}

/// The level picked in each conversation of one host, with the agent it was
/// picked under and a revision per conversation, so a follow-up level
/// request that a later pick or agent change made stale can be dropped.
public struct LevelIntents: Sendable {
    private struct Entry: Sendable {
        let level: ThinkingLevel
        let agent: String?
    }

    private var entries: [UInt64: Entry] = [:]
    private var revisions: [UInt64: UInt64] = [:]

    public init() {}

    /// The reader picked `level` (the shown one included: re-picking a
    /// clamped level replaces the intent).
    public mutating func pick(_ level: ThinkingLevel, conversation id: UInt64, agent: String?) {
        entries[id] = Entry(level: level, agent: agent)
        bump(id)
    }

    /// The agent changed here: its role sets the level.
    public mutating func forget(conversation id: UInt64) {
        entries[id] = nil
        bump(id)
    }

    /// A model switch: the level to ask for once it lands (nil when the
    /// host's own clamp is right) and the revision that request belongs to.
    /// A pick made under another agent, here or on another device, no
    /// longer applies.
    public mutating func switchModel(conversation id: UInt64, agent: String?, current: ThinkingLevel,
                                     levels: [ThinkingLevel]) -> (follow: ThinkingLevel?, revision: UInt64) {
        let entry = entries[id].flatMap { $0.agent == agent ? $0 : nil }
        let intent = entry?.level ?? current
        entries[id] = Entry(level: intent, agent: agent)
        bump(id)
        return (LevelIntent.afterSwitch(levels: levels, intent: intent, current: current), revisions[id] ?? 0)
    }

    /// Whether nothing changed the conversation's level since `revision`.
    public func isCurrent(_ revision: UInt64, conversation id: UInt64) -> Bool {
        revisions[id] == revision
    }

    private mutating func bump(_ id: UInt64) {
        revisions[id, default: 0] += 1
    }
}
