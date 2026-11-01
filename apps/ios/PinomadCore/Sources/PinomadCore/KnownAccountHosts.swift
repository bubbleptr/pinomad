import Foundation

/// The account hosts this iPhone has already seen, per account, for the
/// one-time "new host joined your account" notice (#497). A host joined
/// through the account pairs with every device on its own; the notice is how
/// a phished join gets noticed. The first list after sign-in is the baseline
/// and announces nothing. An account with no entry has no baseline yet,
/// which is not the same as a baseline with no hosts. Persisted as one JSON
/// object in defaults: account key → host ids.
@MainActor
public final class KnownAccountHosts {
    public static let defaultsKey = "pinomad.knownAccountHosts"

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = KnownAccountHosts.defaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    /// The hosts in `hosts` this iPhone hasn't seen on the account, in list
    /// order; afterwards the baseline is exactly `hosts`. A host that left
    /// the account and comes back is a new join, so it is announced again.
    public func observe(serverOrigin: String, username: String, hosts: [AccountHostRow]) -> [AccountHostRow] {
        var all = read()
        let account = Self.accountKey(serverOrigin: serverOrigin, username: username)
        let known = all[account]
        let ids = hosts.map(\.hostId)
        if known != ids {
            all[account] = ids
            write(all)
        }
        guard let known else { return [] }
        let seen = Set(known)
        return hosts.filter { !seen.contains($0.hostId) }
    }

    /// A host confirmed on this iPhone isn't news to it. Before the first
    /// list there is no baseline to add to: that list seeds it, this host
    /// included.
    public func add(serverOrigin: String, username: String, hostId: String) {
        var all = read()
        let account = Self.accountKey(serverOrigin: serverOrigin, username: username)
        guard var known = all[account], !known.contains(hostId) else { return }
        known.append(hostId)
        all[account] = known
        write(all)
    }

    /// A new sign-in starts a new baseline.
    public func reset(serverOrigin: String, username: String) {
        var all = read()
        guard all.removeValue(forKey: Self.accountKey(serverOrigin: serverOrigin, username: username)) != nil
        else { return }
        write(all)
    }

    private static func accountKey(serverOrigin: String, username: String) -> String {
        normalizeServerOrigin(origin: serverOrigin) + " " + username
    }

    private func read() -> [String: [String]] {
        guard let raw = defaults.string(forKey: key),
              let data = raw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String: [String]].self, from: data)
        else { return [:] }
        return decoded
    }

    private func write(_ all: [String: [String]]) {
        guard let data = try? JSONEncoder().encode(all),
              let raw = String(data: data, encoding: .utf8)
        else { return }
        defaults.set(raw, forKey: key)
    }
}
