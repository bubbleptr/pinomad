import PinomadCore

/// What the composer's trailing slot offers for the current draft.
public enum SendSlot: Equatable, Sendable {
    /// Empty draft, nothing running — nothing to do.
    case hidden
    /// Empty draft while a run is going — interrupt it.
    case stop(enabled: Bool)
    /// A draft to send; `canSteer` while busy, where a tap queues a
    /// follow-up and the long-press menu also offers steering.
    case send(enabled: Bool, canSteer: Bool)

    /// Offline calls still report success (the reason only becomes a
    /// notice), so a disconnected send would silently eat the draft —
    /// nothing is live until the connection is back. Images alone are a
    /// message; images still being prepared hold the send (not Stop).
    public init(draft: String, connected: Bool, busy: Bool, hasImages: Bool = false, preparing: Bool = false) {
        if draft.allSatisfy(\.isWhitespace) && !hasImages && !preparing {
            self = busy ? .stop(enabled: connected) : .hidden
        } else if draft.allSatisfy(\.isWhitespace) && !hasImages && busy {
            self = .stop(enabled: connected)
        } else {
            self = .send(enabled: connected && !preparing, canSteer: busy)
        }
    }
}

/// Picks out the notices worth a toast: ones that arrived after the
/// first look. Core notice ids grow monotonically within a session (the
/// list is capped from the front), so tracking the highest id seen is
/// enough. One feed per session — ids restart with a new one.
public struct NoticeFeed: Sendable {
    private var seen: UInt64?

    public init() {}

    public mutating func fresh(_ notices: [Notice]) -> [Notice] {
        let newest = notices.map(\.id).max() ?? 0
        guard let seen else {
            self.seen = newest
            return []
        }
        self.seen = max(seen, newest)
        return notices.filter { $0.id > seen }
    }
}
