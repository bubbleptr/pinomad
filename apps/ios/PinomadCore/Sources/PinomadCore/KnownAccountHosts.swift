import Foundation

/// A host the new-host notice still has to show.
public struct PendingAccountHost: Codable, Hashable, Identifiable, Sendable {
    public var id: String { hostId }
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
///
/// A host is known per join (#531): `hostId@joinedAt`, so a host removed
/// from the account and joined again is news again. A bare `hostId` comes
/// from a build before join times, or from a confirm on this iPhone; it
/// covers the host's next join once.
@MainActor
public final class KnownAccountHosts {
    /// Versioned because a bare `hostId` means something else here than
    /// to a build before #531, which would read a new record as having
    /// seen every host and flip it back on downgrade. The old key is read
    /// once to seed this one and never written.
    public static let defaultsKey = "pinomad.knownAccountHosts.v2"
    public static let legacyDefaultsKey = "pinomad.knownAccountHosts"

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

    /// Adds the joins in `hosts` this iPhone hasn't seen to the pending
    /// notices and returns every notice still pending for the account.
    /// Hosts missing from the list keep what is known about them: a list
    /// can predate a host confirmed here a moment ago, and dropping that
    /// host would announce it next round.
    public func observe(serverOrigin: String, username: String, hosts: [AccountHostRow]) -> [PendingAccountHost] {
        var all = read()
        let account = Self.accountKey(serverOrigin: serverOrigin, username: username)
        guard var entry = all[account] else {
            all[account] = Entry(known: hosts.map(Self.entry), pending: [])
            write(all)
            return []
        }
        var changed = false
        for host in hosts {
            let current = Self.entry(host)
            if entry.known.contains(current) {
                // A confirm of a join already seen is spent; left in place
                // it would cover the next join.
                if host.joinedAt != nil, let bare = entry.known.firstIndex(of: host.hostId) {
                    entry.known.remove(at: bare)
                    changed = true
                }
                continue
            }
            let covered = host.joinedAt == nil
                ? entry.known.contains { $0.hasPrefix(host.hostId + "@") }
                : entry.known.contains(host.hostId)
            if !covered, !entry.pending.contains(where: { $0.hostId == host.hostId }) {
                entry.pending.append(PendingAccountHost(hostId: host.hostId, name: host.name))
            }
            entry.known.removeAll { $0 == host.hostId || $0.hasPrefix(host.hostId + "@") }
            entry.known.append(current)
            changed = true
        }
        if changed {
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

    private static func entry(_ host: AccountHostRow) -> String {
        guard let joinedAt = host.joinedAt else { return host.hostId }
        return "\(host.hostId)@\(Int64(joinedAt))"
    }

    private static func accountKey(serverOrigin: String, username: String) -> String {
        normalizeServerOrigin(origin: serverOrigin) + " " + username
    }

    private func read() -> [String: Entry] {
        let stored = defaults.string(forKey: key)
            ?? (key == Self.defaultsKey ? defaults.string(forKey: Self.legacyDefaultsKey) : nil)
        guard let raw = stored,
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
