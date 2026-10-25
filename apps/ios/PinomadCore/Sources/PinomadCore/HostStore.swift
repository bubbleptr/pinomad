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

/// The path role a published endpoint plays (ADR-0032).
public enum StoredEndpointRole: String, Codable, Sendable, Equatable {
    case direct
    case relay
}

/// One remote socket the host published.
public struct StoredEndpoint: Codable, Sendable, Equatable {
    public var role: StoredEndpointRole
    public var url: String

    public init(role: StoredEndpointRole, url: String) {
        self.role = role
        self.url = url
    }
}

/// The host's remote candidates as the keychain keeps them. Kept separate
/// from the generated FFI record so a malformed/future set can fail on its
/// own without taking the host or the rest of `StoredHosts` with it.
public struct StoredEndpointSet: Codable, Sendable, Equatable {
    public var schemaVersion: Int
    public var endpoints: [StoredEndpoint]

    public init(schemaVersion: Int = 1, endpoints: [StoredEndpoint] = []) {
        self.schemaVersion = schemaVersion
        self.endpoints = endpoints
    }

    /// The same bounds the protocol parser enforces; the FFI validator is the
    /// final authority, this only keeps obviously unusable keychain data out.
    public var isValid: Bool {
        guard schemaVersion == 1, endpoints.count <= 4 else { return false }
        var seen = Set<String>()
        for endpoint in endpoints {
            guard !endpoint.url.isEmpty, endpoint.url.utf16.count <= 1024,
                  URL(string: endpoint.url).map({ $0.scheme == "ws" || $0.scheme == "wss" }) == true,
                  seen.insert(endpoint.url).inserted
            else { return false }
        }
        return true
    }

    public var ffi: EndpointSet {
        EndpointSet(
            schemaVersion: UInt32(schemaVersion),
            endpoints: endpoints.map {
                HostEndpoint(role: $0.role == .relay ? .relay : .direct, url: $0.url)
            })
    }

    public init?(_ ffi: EndpointSet) {
        let set = StoredEndpointSet(
            schemaVersion: Int(ffi.schemaVersion),
            endpoints: ffi.endpoints.map {
                StoredEndpoint(role: $0.role == .relay ? .relay : .direct, url: $0.url)
            })
        guard set.isValid else { return nil }
        self = set
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
    /// The host's last published remote candidates (5.22, ADR-0032). Absent
    /// on old records and when the stored set was unusable.
    public var endpointSet: StoredEndpointSet?
    public var pairedAt: Date

    public init(
        url: String,
        hostKey: String,
        privateKey: String,
        name: String? = nil,
        account: AccountLink? = nil,
        endpointSet: StoredEndpointSet? = nil,
        pairedAt: Date = Date()
    ) {
        self.url = url
        self.hostKey = hostKey
        self.privateKey = privateKey
        self.name = name
        self.account = account
        self.endpointSet = endpointSet
        self.pairedAt = pairedAt
    }

    private enum CodingKeys: String, CodingKey {
        case url, hostKey, privateKey, name, account, endpointSet, pairedAt
    }

    /// Decode each host on its own optional endpoint boundary: a malformed or
    /// future `endpointSet` loses that field, never the device key or the
    /// other hosts in the keychain item.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        url = try container.decode(String.self, forKey: .url)
        hostKey = try container.decode(String.self, forKey: .hostKey)
        privateKey = try container.decode(String.self, forKey: .privateKey)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        account = try container.decodeIfPresent(AccountLink.self, forKey: .account)
        endpointSet = (try? container.decodeIfPresent(StoredEndpointSet.self, forKey: .endpointSet))
            .flatMap { $0 }
        if endpointSet?.isValid != true { endpointSet = nil }
        pairedAt = try container.decode(Date.self, forKey: .pairedAt)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(url, forKey: .url)
        try container.encode(hostKey, forKey: .hostKey)
        try container.encode(privateKey, forKey: .privateKey)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(account, forKey: .account)
        if let endpointSet, endpointSet.isValid {
            try container.encode(endpointSet, forKey: .endpointSet)
        }
        try container.encode(pairedAt, forKey: .pairedAt)
    }

    /// The FFI record `PinomadClient.connect` takes — run through
    /// `validateStoredHost` before use.
    public var ffi: StoredHost {
        StoredHost(
            url: url,
            hostKey: hostKey,
            privateKey: privateKey,
            name: name,
            account: account.map { StoredHostAccount(serverOrigin: $0.serverOrigin, hostId: $0.hostId) },
            endpointSet: endpointSet?.ffi
        )
    }

    /// Apply one validated endpoint update and the legacy URL that old
    /// clients should see. The caller has already merged identity/name/account
    /// under the store lock.
    public func applyingEndpoints(url nextURL: String, endpointSet nextSet: StoredEndpointSet) -> HostRecord {
        var next = self
        next.endpointSet = nextSet
        next.url = nextURL
        return next
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

    /// Apply a validated hello endpoint update to one stored host. A host
    /// forgotten before the late update lands is not resurrected; name,
    /// account, private key and pairing time stay untouched.
    public func settingEndpoints(
        _ endpointSet: StoredEndpointSet,
        url: String,
        for hostKey: String
    ) -> StoredHosts? {
        guard let index = hosts.firstIndex(where: { $0.hostKey == hostKey }) else {
            return nil
        }
        let nextHost = hosts[index].applyingEndpoints(url: url, endpointSet: endpointSet)
        guard nextHost != hosts[index] else { return nil }
        var next = self
        next.hosts[index] = nextHost
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
