import Foundation

/// The host or pairing identity the connection on screen is for. A pairing
/// link is one-time: once the handshake returns the stored host record, the
/// link is spent and a retry must connect to that host instead of replaying
/// the code.
public struct PairingAttempt: Equatable, Sendable {
    public private(set) var host: HostRecord?
    public private(set) var link: String?
    public private(set) var account: AccountLink?
    public private(set) var target: PairingTarget?

    public init() {}

    public mutating func connect(_ host: HostRecord) {
        self.host = host
        link = nil
        account = nil
        target = nil
    }

    public mutating func pair(link: String, account: AccountLink?, target: PairingTarget?) {
        self.link = link
        self.account = account
        self.target = target
        host = nil
    }

    /// The handshake completed and spent the link; this session is the
    /// stored host's device now.
    public mutating func paired(_ host: HostRecord) {
        self.host = host
        link = nil
        account = nil
        target = nil
    }

    /// A hello learned new endpoints for this host. Only the routing fields
    /// move: the in-memory device identity, name, account and pairing time
    /// are the ones the host accepted, even when the keychain save failed.
    public mutating func endpoints(_ patch: HostRecord) {
        guard var host, host.hostKey == patch.hostKey else { return }
        host.url = patch.url
        host.endpointSet = patch.endpointSet
        self.host = host
    }

    public mutating func clear() {
        host = nil
        link = nil
        account = nil
        target = nil
    }

    public enum Retry: Equatable, Sendable {
        case link(String, AccountLink?)
        case host(HostRecord)
        case active
    }

    public var retry: Retry {
        if let link { return .link(link, account) }
        if let host { return .host(host) }
        return .active
    }
}
