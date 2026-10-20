import Foundation
import Security

/// The account linkage of a paired host (ADR-0022): which server bound
/// the host and under what hostId. Mirrors `StoredHostAccount`.
public struct AccountLink: Codable, Sendable, Equatable {
    public var serverOrigin: String
    public var hostId: String

    public init(serverOrigin: String, hostId: String) {
        self.serverOrigin = serverOrigin
        self.hostId = hostId
    }
}

/// One paired host as the keychain keeps it — the `Paired` payload plus
/// the account linkage loaded back later. Multi-host shaped already
/// (step 4); this step only ever uses the active one.
public struct HostRecord: Codable, Sendable, Equatable {
    public var url: String
    public var hostKey: String
    public var privateKey: String
    /// The machine name cached from the host's settings stream (5.12).
    /// `nil` for records written before names existed or before the stream
    /// lands; the label falls back to the address then.
    public var name: String?
    public var account: AccountLink?
    public var pairedAt: Date

    public init(
        url: String,
        hostKey: String,
        privateKey: String,
        name: String? = nil,
        account: AccountLink? = nil,
        pairedAt: Date = Date()
    ) {
        self.url = url
        self.hostKey = hostKey
        self.privateKey = privateKey
        self.name = name
        self.account = account
        self.pairedAt = pairedAt
    }

    /// The FFI record `PinomadClient.connect` takes — run through
    /// `validateStoredHost` before use.
    public var ffi: StoredHost {
        StoredHost(
            url: url,
            hostKey: hostKey,
            privateKey: privateKey,
            name: name,
            account: account.map { StoredHostAccount(serverOrigin: $0.serverOrigin, hostId: $0.hostId) }
        )
    }
}

/// The whole keychain payload: every paired host plus which one to
/// reconnect on launch.
public struct StoredHosts: Codable, Sendable, Equatable {
    public var hosts: [HostRecord]
    /// `hostKey` of the last-connected host.
    public var activeHostKey: String?

    public init(hosts: [HostRecord] = [], activeHostKey: String? = nil) {
        self.hosts = hosts
        self.activeHostKey = activeHostKey
    }

    public var active: HostRecord? {
        hosts.first { $0.hostKey == activeHostKey } ?? hosts.first
    }

    /// Without `hostKey`; if it was the active one, the first host left
    /// takes over.
    public func forgetting(_ hostKey: String) -> StoredHosts {
        var next = self
        next.hosts.removeAll { $0.hostKey == hostKey }
        if next.activeHostKey == hostKey { next.activeHostKey = nil }
        return next
    }

    /// With `hostKey` active — unchanged if no such host is stored.
    public func activating(_ hostKey: String) -> StoredHosts {
        guard hosts.contains(where: { $0.hostKey == hostKey }) else { return self }
        var next = self
        next.activeHostKey = hostKey
        return next
    }

    /// Apply the name a 5.12 host announced for `hostKey`. Display
    /// metadata only: order and the launch choice stay put, and an entry
    /// forgotten since the announcement is not brought back. `nil` means
    /// nothing to write — no announcement (older host, stream not landed),
    /// an empty one, no such entry, or the cached name is already current.
    public func settingName(_ announced: String?, for hostKey: String) -> StoredHosts? {
        guard let announced, !announced.isEmpty,
              let index = hosts.firstIndex(where: { $0.hostKey == hostKey }),
              hosts[index].name != announced
        else { return nil }
        var next = self
        next.hosts[index].name = announced
        return next
    }
}

public enum HostStoreError: Error, Equatable {
    /// A Security-framework call failed; associated value is the OSStatus.
    case keychain(Int32)
    /// The stored bytes are not a `StoredHosts` — corrupt record.
    case corrupt
}

/// Where the pairing lands. Read/write failures are thrown to the
/// caller — a silently lost key would look like a vanished pairing.
public protocol HostStore: Sendable {
    func load() throws -> StoredHosts
    func save(_ hosts: StoredHosts) throws
    /// One locked load/mutate/save. Account-link adoption, pairing handshakes
    /// and forget all rewrite the same item; a plain load+save pair would
    /// clobber a concurrent writer's private key.
    func update(_ body: (inout StoredHosts) throws -> Void) throws
}

/// One generic-password item holding the `StoredHosts` JSON —
/// `ThisDeviceOnly` keeps keys off iCloud Keychain, matching the Expo
/// version's `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
public struct KeychainHostStore: HostStore {
    /// Shared by every instance (the app and each session loop create their
    /// own), so all read-modify-write sequences are serialized.
    private static let lock = NSLock()

    private let service: String
    private let account: String

    public init(service: String = "build.kieran.pinomad.hosts", account: String = "pinomad.hosts.v1") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }

    public func load() throws -> StoredHosts {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        return try read()
    }

    public func save(_ hosts: StoredHosts) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        try write(hosts)
    }

    public func update(_ body: (inout StoredHosts) throws -> Void) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var hosts = try read()
        try body(&hosts)
        try write(hosts)
    }

    private func read() throws -> StoredHosts {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        switch status {
        case errSecItemNotFound:
            return StoredHosts()
        case errSecSuccess:
            guard let data = item as? Data,
                  let hosts = try? JSONDecoder().decode(StoredHosts.self, from: data)
            else { throw HostStoreError.corrupt }
            return hosts
        default:
            throw HostStoreError.keychain(status)
        }
    }

    private func write(_ hosts: StoredHosts) throws {
        let data = try JSONEncoder().encode(hosts)
        var request = query
        request[kSecValueData as String] = data
        let status = SecItemAdd(request as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = [kSecValueData as String: data] as CFDictionary
            let updated = SecItemUpdate(query as CFDictionary, update)
            guard updated == errSecSuccess else { throw HostStoreError.keychain(updated) }
        } else if status != errSecSuccess {
            throw HostStoreError.keychain(status)
        }
    }
}
