import Foundation

/// A host the new-host notice still has to show.
public struct PendingAccountHost: Codable, Equatable, Sendable {
    public var hostId: String
    public var name: String

    public init(hostId: String, name: String) {
        self.hostId = hostId
        self.name = name
    }
}

/// The account hosts this iPhone has already seen, per account, for the
/// one-time "new host joined your account" notice (#497). A host joined
/// through the account pairs with every device on its own; the notice is how
/// a phished join gets noticed. The first list after sign-in is the baseline
/// and announces nothing. An account with no entry has no baseline yet,
/// which is not the same as a baseline with no hosts.
///
/// A host found later is known at once and pending until the reader
/// dismisses its notice, and both are persisted together: the notice can
/// wait for a sheet to close, and iOS may end the app meanwhile. Persisted
/// as one JSON object in defaults, account key → entry.
@MainActor
public final class KnownAccountHosts {
    public static let defaultsKey = "pinomad.knownAccountHosts"

    private struct Entry: Codable {
        var known: [String]
        var pending: [PendingAccountHost]
    }

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = KnownAccountHosts.defaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    /// Adds the hosts in `hosts` this iPhone hasn't seen to the pending
    /// notices and returns every notice still pending for the account.
    /// Nothing leaves the known set: a list can predate a host confirmed
    /// here a moment ago, and dropping that host would announce it next
    /// round.
    public func observe(serverOrigin: String, username: String, hosts: [AccountHostRow]) -> [PendingAccountHost] {
        var all = read()
        let account = Self.accountKey(serverOrigin: serverOrigin, username: username)
        guard var entry = all[account] else {
            all[account] = Entry(known: hosts.map(\.hostId), pending: [])
            write(all)
            return []
        }
        let seen = Set(entry.known)
        let joined = hosts.filter { !seen.contains($0.hostId) }
        if !joined.isEmpty {
            entry.known += joined.map(\.hostId)
            entry.pending += joined.map { PendingAccountHost(hostId: $0.hostId, name: $0.name) }
            all[account] = entry
            write(all)
        }
        return entry.pending
    }

    /// The notices still waiting, for a relaunch to show again.
    public func pending(serverOrigin: String, username: String) -> [PendingAccountHost] {
        read()[Self.accountKey(serverOrigin: serverOrigin, username: username)]?.pending ?? []
    }

    /// The reader has seen these notices: they are not shown again.
    public func dismiss(serverOrigin: String, username: String, hostIds: [String]) {
        var all = read()
        let account = Self.accountKey(serverOrigin: serverOrigin, username: username)
        guard var entry = all[account] else { return }
        let dismissed = Set(hostIds)
        let before = entry.pending.count
        entry.pending.removeAll { dismissed.contains($0.hostId) }
        guard entry.pending.count != before else { return }
        all[account] = entry
        write(all)
    }

    /// A host confirmed on this iPhone isn't news to it, even if a list
    /// that landed just before the confirmation already found it. Before
    /// the first list there is no baseline to add to: that list seeds it,
    /// this host included.
    public func add(serverOrigin: String, username: String, hostId: String) {
        var all = read()
        let account = Self.accountKey(serverOrigin: serverOrigin, username: username)
        guard var entry = all[account] else { return }
        let wasKnown = entry.known.contains(hostId)
        let before = entry.pending.count
        if !wasKnown { entry.known.append(hostId) }
        entry.pending.removeAll { $0.hostId == hostId }
        guard !wasKnown || entry.pending.count != before else { return }
        all[account] = entry
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

    private func read() -> [String: Entry] {
        guard let raw = defaults.string(forKey: key),
              let data = raw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String: Entry].self, from: data)
        else { return [:] }
        return decoded
    }

    private func write(_ all: [String: Entry]) {
        guard let data = try? JSONEncoder().encode(all),
              let raw = String(data: data, encoding: .utf8)
        else { return }
        defaults.set(raw, forKey: key)
    }
}
