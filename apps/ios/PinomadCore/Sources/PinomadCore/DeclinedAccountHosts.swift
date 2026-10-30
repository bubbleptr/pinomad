import Foundation

/// One account-host identity as the declined set keeps it (ADR-0035 §5):
/// the server origin that vouched for it plus the server's hostId.
public struct AccountHostIdentity: Codable, Hashable, Sendable {
    public var serverOrigin: String
    public var hostId: String

    public init(serverOrigin: String, hostId: String) {
        self.serverOrigin = normalizeServerOrigin(origin: serverOrigin)
        self.hostId = hostId
    }

    private enum CodingKeys: String, CodingKey {
        case serverOrigin, hostId
    }

    /// Origins are canonical on the way in as well as out: a stored value
    /// from an older build must not split one identity into two entries.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            serverOrigin: try container.decode(String.self, forKey: .serverOrigin),
            hostId: try container.decode(String.self, forKey: .hostId))
    }
}

/// Account hosts this device must not register automatically: the reader
/// forgot them, or the host refused account vouching. Only an explicit "join"
/// removes an identity. Persisted as one JSON array in defaults.
@MainActor
public final class DeclinedAccountHosts {
    public static let defaultsKey = "pinomad.declinedAccountHosts"

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = DeclinedAccountHosts.defaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    public func list() -> [AccountHostIdentity] {
        guard let raw = defaults.string(forKey: key),
              let data = raw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([AccountHostIdentity].self, from: data)
        else { return [] }
        var seen: Set<AccountHostIdentity> = []
        return decoded.filter { seen.insert($0).inserted }
    }

    public func contains(serverOrigin: String, hostId: String) -> Bool {
        let identity = AccountHostIdentity(serverOrigin: serverOrigin, hostId: hostId)
        return list().contains(identity)
    }

    /// Returns whether the set changed. A repeated decline is a no-op, so the
    /// caller does not rewrite defaults on every foreground refresh.
    @discardableResult
    public func add(serverOrigin: String, hostId: String) -> Bool {
        let identity = AccountHostIdentity(serverOrigin: serverOrigin, hostId: hostId)
        var identities = list()
        guard !identities.contains(identity) else { return false }
        identities.append(identity)
        write(identities)
        return true
    }

    @discardableResult
    public func remove(serverOrigin: String, hostId: String) -> Bool {
        let identity = AccountHostIdentity(serverOrigin: serverOrigin, hostId: hostId)
        let identities = list()
        let next = identities.filter { $0 != identity }
        guard next.count != identities.count else { return false }
        write(next)
        return true
    }

    private func write(_ identities: [AccountHostIdentity]) {
        guard let data = try? JSONEncoder().encode(identities),
              let raw = String(data: data, encoding: .utf8)
        else { return }
        defaults.set(raw, forKey: key)
    }
}
