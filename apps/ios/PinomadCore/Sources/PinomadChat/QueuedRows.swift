import PinomadCore

/// The composer's waiting list: host inbox rows (already sent, one check)
/// followed by local sends the host has not admitted yet.
public enum QueuedRow: Equatable, Sendable, Identifiable {
    case host(QueueItem)
    case local(LocalQueueItem)

    public var id: String {
        switch self {
        case let .host(item): "host:\(item.id)"
        case let .local(item): "local:\(item.requestId)"
        }
    }

    public var status: MessageStatus {
        switch self {
        case .host: .sent
        case let .local(item): MessageStatus(item.status)
        }
    }
}

public enum QueuedList {
    /// Host rows first: the order the inbox holds, then this client's sends.
    public static func rows(host: [QueueItem], local: [LocalQueueItem]) -> [QueuedRow] {
        host.map(QueuedRow.host) + local.map(QueuedRow.local)
    }

    public enum Side: Sendable { case before, after }

    /// A row moves only among host inputs of its own mode: a steer lands at
    /// the next boundary and a follow-up after the run, so crossing them
    /// would show an order the host does not deliver. Writes never move.
    public static func peers(of item: QueueItem, in items: [QueueItem]) -> [QueueItem] {
        guard isInput(item.mode) else { return [] }
        return items.filter { $0.mode == item.mode }
    }

    /// The `before` argument of reorderQueued that lands `moved` on `side`
    /// of `target`: the target itself, or the next queued input after it in
    /// the whole inbox (nil at the end). Writes are skipped — the host
    /// refuses one as `before`.
    public static func before(
        moving moved: UInt64, onto target: UInt64, side: Side, in items: [QueueItem]
    ) -> UInt64? {
        if side == .before { return target }
        let inputs = items.filter { $0.id != moved && isInput($0.mode) }
        guard let at = inputs.firstIndex(where: { $0.id == target }),
              at + 1 < inputs.count
        else { return nil }
        return inputs[at + 1].id
    }

    /// One step up (-1) or down (+1) among the row's peers; nil when there
    /// is no peer that way.
    public static func move(_ id: UInt64, by step: Int, in items: [QueueItem]) -> QueuedMove? {
        guard let item = items.first(where: { $0.id == id }) else { return nil }
        let peers = peers(of: item, in: items)
        guard let index = peers.firstIndex(where: { $0.id == id }),
              peers.indices.contains(index + step)
        else { return nil }
        let target = peers[index + step].id
        return QueuedMove(before: before(
            moving: id, onto: target, side: step < 0 ? .before : .after, in: items))
    }

    private static func isInput(_ mode: QueueMode) -> Bool {
        mode == .steer || mode == .followUp
    }
}

/// Where a reorder puts a row: right before `before`, or last when nil.
public struct QueuedMove: Equatable, Sendable {
    public let before: UInt64?

    public init(before: UInt64?) { self.before = before }
}
