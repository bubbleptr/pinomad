import Foundation
import Security

/// The account linkage of a paired host (ADR-0022): which server bound
/// the host and under what hostId. Mirrors `StoredHostAccount`.
public struct AccountLink: Codable, Sendable, Equatable {
    public var serverOrigin: String
    public var hostId: String
    /// This device's key came from the account's own offer, so the server
    /// vouched for it (#494). Absent when the link was adopted onto a QR
    /// pairing sharing the Noise key, or written before #494; a
    /// shared-device sign-out keeps such a key. Same field as the web's
    /// `StoredHostAccount.vouched`.
    public var vouched: Bool?

    public init(serverOrigin: String, hostId: String, vouched: Bool = false) {
        self.serverOrigin = serverOrigin
        self.hostId = hostId
        self.vouched = vouched ? true : nil
    }

    /// The same link without the vouch: what a re-pair under another key keeps.
    public var unvouched: AccountLink {
        AccountLink(serverOrigin: serverOrigin, hostId: hostId)
    }
}

/// How this device reaches one host (ADR-0033 §5): the relay is always
/// allowed in Auto, never carries business data in Direct only, and no
/// peer-to-peer path is tried in Relay only. A missing/unknown stored value
/// means Auto.
public enum HostConnectionMode: String, Codable, Sendable, Equatable, CaseIterable {
    case auto
    case directOnly
    case relayOnly

    public var label: String {
        switch self {
        case .auto: "Auto"
        case .directOnly: "Direct only"
        case .relayOnly: "Relay only"
        }
    }

    public var footer: String {
        switch self {
        case .auto:
            "Start on the relay, then switch to a direct peer-to-peer link once it is stable."
        case .directOnly:
            "Never send conversation data through the PiNomad server. The relay is used only to set up the link."
        case .relayOnly:
            "Always go through the relay; never try peer-to-peer."
        }
    }
}

/// The path role a published endpoint plays (ADR-0032).
public enum StoredEndpointRole: String, Codable, Sendable, Equatable {
    case direct
    case relay
}

/// The only transport this build knows how to dial.
public enum StoredEndpointTransport: String, Codable, Sendable, Equatable {
    case webSocket
}

/// One remote socket the host published.
public struct StoredEndpoint: Codable, Sendable, Equatable {
    public var transport: StoredEndpointTransport
    public var role: StoredEndpointRole
    public var url: String

    public init(
        transport: StoredEndpointTransport = .webSocket,
        role: StoredEndpointRole,
        url: String
    ) {
        self.transport = transport
        self.role = role
        self.url = url
    }

    /// Exact UTF-16 equality, like the protocol identity. Swift's String
    /// equality is canonical and would merge composed/decomposed URLs.
    public static func == (lhs: StoredEndpoint, rhs: StoredEndpoint) -> Bool {
        lhs.transport == rhs.transport
            && lhs.role == rhs.role
            && lhs.url.utf16.elementsEqual(rhs.url.utf16)
    }
}

/// The host's remote candidates as the keychain keeps them. Kept separate
/// from the generated FFI record so a malformed/future set can fail on its
/// own without taking the host or the rest of `StoredHosts` with it.
public struct StoredEndpointSet: Codable, Sendable, Equatable {
    public var schemaVersion: Int
    public var endpoints: [StoredEndpoint]

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, endpoints
    }

    private enum EndpointKeys: String, CodingKey {
        case transport, role, url
    }

    /// Protocol identity is exact UTF-16 code units, not Swift's canonical
    /// String equivalence (composed and decomposed URLs are distinct).
    private struct ExactURL: Hashable {
        let units: [UInt16]

        init(_ url: String) {
            units = Array(url.utf16)
        }
    }

    public init(schemaVersion: Int = 1, endpoints: [StoredEndpoint] = []) {
        self.schemaVersion = schemaVersion
        self.endpoints = endpoints
    }

    public static func == (lhs: StoredEndpointSet, rhs: StoredEndpointSet) -> Bool {
        lhs.schemaVersion == rhs.schemaVersion && lhs.endpoints == rhs.endpoints
    }

    /// Decode with the protocol table: unknown transports are skipped, a set
    /// made only of them is unsupported, identical same-role entries dedupe
    /// first-wins, and a role conflict is malformed. The caller's `try?`
    /// boundary drops only this field.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .schemaVersion)
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion, in: container,
                debugDescription: "unsupported endpoint schema")
        }
        var raw = try container.nestedUnkeyedContainer(forKey: .endpoints)
        var rawCount = 0
        var roles: [ExactURL: StoredEndpointRole] = [:]
        var endpoints: [StoredEndpoint] = []
        while !raw.isAtEnd {
            rawCount += 1
            guard rawCount <= 4 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .endpoints, in: container,
                    debugDescription: "too many endpoints")
            }
            let entry = try raw.nestedContainer(keyedBy: EndpointKeys.self)
            let transport = try entry.decode(String.self, forKey: .transport)
            guard transport == StoredEndpointTransport.webSocket.rawValue else { continue }
            let roleText = try entry.decode(String.self, forKey: .role)
            guard let role = StoredEndpointRole(rawValue: roleText) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .role, in: entry,
                    debugDescription: "unknown endpoint role")
            }
            let url = try entry.decode(String.self, forKey: .url)
            guard Self.isSocketURL(url) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .url, in: entry,
                    debugDescription: "not a ws:/wss: endpoint")
            }
            let identity = ExactURL(url)
            if let prior = roles[identity] {
                if prior != role {
                    throw DecodingError.dataCorruptedError(
                        forKey: .url, in: entry,
                        debugDescription: "endpoint role conflict")
                }
                continue
            }
            roles[identity] = role
            endpoints.append(StoredEndpoint(role: role, url: url))
        }
        guard !endpoints.isEmpty || rawCount == 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .endpoints, in: container,
                debugDescription: "no supported endpoint transport")
        }
        schemaVersion = version
        self.endpoints = endpoints
    }

    /// The same bounds the protocol parser enforces; the FFI validator is the
    /// final authority, this only keeps obviously unusable keychain data out.
    public var isValid: Bool {
        guard schemaVersion == 1, endpoints.count <= 4 else { return false }
        var roles: [ExactURL: StoredEndpointRole] = [:]
        for endpoint in endpoints {
            guard endpoint.transport == .webSocket, Self.isSocketURL(endpoint.url) else { return false }
            let identity = ExactURL(endpoint.url)
            if let prior = roles[identity] {
                guard prior == endpoint.role else { return false }
                continue
            }
            roles[identity] = endpoint.role
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
        guard ffi.schemaVersion == 1, ffi.endpoints.count <= 4 else { return nil }
        var roles: [ExactURL: StoredEndpointRole] = [:]
        var endpoints: [StoredEndpoint] = []
        for entry in ffi.endpoints {
            let role: StoredEndpointRole = entry.role == .relay ? .relay : .direct
            guard Self.isSocketURL(entry.url) else { return nil }
            let identity = ExactURL(entry.url)
            if let prior = roles[identity] {
                guard prior == role else { return nil }
                continue
            }
            roles[identity] = role
            endpoints.append(StoredEndpoint(role: role, url: entry.url))
        }
        self.init(endpoints: endpoints)
    }

    private static func isSocketURL(_ url: String) -> Bool {
        guard !url.isEmpty, url.utf16.count <= 1024,
              let scheme = URL(string: url)?.scheme?.lowercased()
        else { return false }
        return scheme == "ws" || scheme == "wss"
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
    /// The user's connection-mode choice (ADR-0033 §5). Absent means Auto.
    public var connectionMode: HostConnectionMode?
    /// The learned `hello.rtc.signalOnly` hint: true means the relay is
    /// required for signaling. Absent/false means unknown or not needed.
    public var rtcSignalOnly: Bool?
    public var pairedAt: Date

    public init(
        url: String,
        hostKey: String,
        privateKey: String,
        name: String? = nil,
        account: AccountLink? = nil,
        endpointSet: StoredEndpointSet? = nil,
        connectionMode: HostConnectionMode? = nil,
        rtcSignalOnly: Bool? = nil,
        pairedAt: Date = Date()
    ) {
        self.url = url
        self.hostKey = hostKey
        self.privateKey = privateKey
        self.name = name
        self.account = account
        self.endpointSet = endpointSet
        self.connectionMode = connectionMode
        self.rtcSignalOnly = rtcSignalOnly
        self.pairedAt = pairedAt
    }

    private enum CodingKeys: String, CodingKey {
        case url, hostKey, privateKey, name, account, endpointSet, connectionMode, rtcSignalOnly, pairedAt
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
        // A bad mode or hint costs only that field; the private key and the
        // rest of the list must survive whatever a future/hand-edited record
        // holds.
        connectionMode = (try? container.decodeIfPresent(HostConnectionMode.self, forKey: .connectionMode))
            .flatMap { $0 }
        rtcSignalOnly = (try? container.decodeIfPresent(Bool.self, forKey: .rtcSignalOnly))
            .flatMap { $0 }
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
        try container.encodeIfPresent(connectionMode, forKey: .connectionMode)
        try container.encodeIfPresent(rtcSignalOnly, forKey: .rtcSignalOnly)
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
            endpointSet: endpointSet?.ffi,
            connectionMode: connectionMode?.rawValue,
            rtcSignalOnly: rtcSignalOnly
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

extension StoredHosts {
    /// Apply the user's mode choice to one stored host. Everything else
    /// (key material, name, account, endpoints) is untouched.
    public func settingConnectionMode(_ mode: HostConnectionMode, for hostKey: String) -> StoredHosts? {
        guard let index = hosts.firstIndex(where: { $0.hostKey == hostKey }),
              hosts[index].connectionMode != mode
        else { return nil }
        var next = self
        next.hosts[index].connectionMode = mode
        return next
    }

    /// Apply the learned signal-only hint to one host. `false` is stored
    /// explicitly: it disproves an earlier hint after a failed signal-only
    /// handshake, so dropping it would retry the same dead path.
    public func settingSignalOnly(_ signalOnly: Bool, for hostKey: String) -> StoredHosts? {
        guard let index = hosts.firstIndex(where: { $0.hostKey == hostKey }),
              hosts[index].rtcSignalOnly != signalOnly
        else { return nil }
        var next = self
        next.hosts[index].rtcSignalOnly = signalOnly
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
        let before = hosts
        try body(&hosts)
        // A repeated identical hello must not rewrite the keychain (and must
        // not turn a successful read into a spurious save warning).
        guard hosts != before else { return }
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
