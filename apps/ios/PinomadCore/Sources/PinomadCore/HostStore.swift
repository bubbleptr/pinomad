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
    public var account: AccountLink?
    public var pairedAt: Date

    public init(
        url: String,
        hostKey: String,
        privateKey: String,
        account: AccountLink? = nil,
        pairedAt: Date = Date()
    ) {
        self.url = url
        self.hostKey = hostKey
        self.privateKey = privateKey
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
}

/// One generic-password item holding the `StoredHosts` JSON —
/// `ThisDeviceOnly` keeps keys off iCloud Keychain, matching the Expo
/// version's `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
public struct KeychainHostStore: HostStore {
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

    public func save(_ hosts: StoredHosts) throws {
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
