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
