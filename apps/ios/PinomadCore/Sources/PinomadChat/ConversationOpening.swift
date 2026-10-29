/// Which conversation page's open settled without the conversation on
/// screen. A conversation page shows at once and loads behind a skeleton;
/// the switch is command-class (a refusal becomes a notice) and a dropped
/// connection ends it too, so its outcome is read from what the core shows
/// once it settles. Only the latest open decides: going back from a child
/// page reopens the parent, and the child's late outcome is stale by then.
public struct ConversationOpening: Sendable {
    public private(set) var failed: UInt64?
    private var latest = 0

    public init() {}

    /// A new open of `id`; whatever failed before goes back to loading.
    public mutating func begin(_ id: UInt64) -> Int {
        latest += 1
        failed = nil
        return latest
    }

    /// The open numbered `attempt` settled with `shown` on screen.
    public mutating func settle(_ id: UInt64, attempt: Int, shown: UInt64?) {
        guard attempt == latest else { return }
        failed = shown == id ? nil : id
    }
}
