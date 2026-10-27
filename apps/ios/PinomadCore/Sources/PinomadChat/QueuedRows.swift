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
}
