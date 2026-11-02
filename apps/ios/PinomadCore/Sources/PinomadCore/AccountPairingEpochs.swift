import Foundation

/// Which in-flight account pairing asks may still act on their answer
/// (ADR-0035 §5, #512). A sign-in change or a connection the reader chose
/// makes every ask stale; removing or forgetting one host makes only that
/// host's asks, automatic or explicit, stale, so a join of another host
/// carries on.
public struct AccountPairingEpochs: Equatable, Sendable {
    /// What an ask captured before it awaited the server.
    public struct Ticket: Equatable, Sendable {
        fileprivate let all: UInt64
        fileprivate let hostId: String
        fileprivate let host: UInt64
    }

    private var all: UInt64 = 0
    private var hosts: [String: UInt64] = [:]

    public init() {}

    public func ticket(hostId: String) -> Ticket {
        Ticket(all: all, hostId: hostId, host: hosts[hostId] ?? 0)
    }

    public func isCurrent(_ ticket: Ticket) -> Bool {
        ticket.all == all && ticket.host == (hosts[ticket.hostId] ?? 0)
    }

    public mutating func invalidateAll() {
        all &+= 1
    }

    public mutating func invalidate(hostId: String) {
        hosts[hostId, default: 0] &+= 1
    }
}
