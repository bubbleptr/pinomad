import Foundation
import Security

// The server-accounts platform layer (ADR-0022): the core builds each
// request and parses each answer (ADR-0024 §3); this file owns the transport,
// the keychain session, and the pure decisions the UI reads. Nothing here
// logs a token or writes one to UserDefaults.

// MARK: - Session

/// One live bearer session. The token lives in the keychain and in this
/// value only — never in logs or defaults.
public struct AccountSession: Codable, Equatable, Sendable {
    public var serverOrigin: String
    public var username: String
    public var token: String
    /// Epoch milliseconds, exactly as /api/login reports it.
    public var expiresAt: Double

    public init(serverOrigin: String, username: String, token: String, expiresAt: Double) {
        self.serverOrigin = serverOrigin
        self.username = username
        self.token = token
        self.expiresAt = expiresAt
    }

    public func isExpired(at now: Date = Date()) -> Bool {
        expiresAt <= now.timeIntervalSince1970 * 1000
    }
}

/// What the keychain keeps for the one account: the signed-in session, or —
/// after signing out or an expired token — just enough to prefill the form.
public struct AccountRecord: Codable, Equatable, Sendable {
    public var serverOrigin: String
    public var username: String
    public var token: String?
    public var expiresAt: Double?

    public init(serverOrigin: String, username: String, token: String? = nil, expiresAt: Double? = nil) {
        self.serverOrigin = serverOrigin
        self.username = username
        self.token = token
        self.expiresAt = expiresAt
    }

    public init(session: AccountSession) {
        self.init(
            serverOrigin: session.serverOrigin,
            username: session.username,
            token: session.token,
            expiresAt: session.expiresAt)
    }

    public var session: AccountSession? {
        guard let token, let expiresAt, !token.isEmpty else { return nil }
        return AccountSession(
            serverOrigin: serverOrigin,
            username: username,
            token: token,
            expiresAt: expiresAt)
    }

    /// Keep the address and username for the next sign-in, drop the token.
    public func clearingToken() -> AccountRecord {
        AccountRecord(serverOrigin: serverOrigin, username: username)
    }
}

public enum AccountStoreError: Error, Equatable {
    /// A Security-framework call failed; associated value is the OSStatus.
    case keychain(Int32)
    /// The stored bytes are not an AccountRecord.
    case corrupt
}

/// Where the one account session lands. A read/write failure is reported to
/// the caller — a token that silently vanished would look like a logout.
public protocol AccountStore: Sendable {
    func load() throws -> AccountRecord?
    func save(_ record: AccountRecord) throws
    func clear() throws
}

/// The account's own generic-password item, separate from the host pairing
/// item (build.kieran.pinomad.hosts). Same ThisDeviceOnly lifetime.
public struct KeychainAccountStore: AccountStore {
    private let service: String
    private let account: String

    public init(
        service: String = "build.kieran.pinomad.account",
        account: String = "pinomad.account.v1"
    ) {
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

    public func load() throws -> AccountRecord? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        switch status {
        case errSecItemNotFound:
            return nil
        case errSecSuccess:
            guard let data = item as? Data,
                  let record = try? JSONDecoder().decode(AccountRecord.self, from: data)
            else { throw AccountStoreError.corrupt }
            return record
        default:
            throw AccountStoreError.keychain(status)
        }
    }

    public func save(_ record: AccountRecord) throws {
        let data = try JSONEncoder().encode(record)
        var request = query
        request[kSecValueData as String] = data
        let status = SecItemAdd(request as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = [kSecValueData as String: data] as CFDictionary
            let updated = SecItemUpdate(query as CFDictionary, update)
            guard updated == errSecSuccess else { throw AccountStoreError.keychain(updated) }
        } else if status != errSecSuccess {
            throw AccountStoreError.keychain(status)
        }
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AccountStoreError.keychain(status)
        }
    }
}

// MARK: - Failures

/// A failed account call with the same code surface the web client uses.
/// The platform invents network (no answer) and invalid_response (a 2xx
/// whose shape didn't fit); everything else is the server's error verbatim.
public struct AccountFailure: Error, Equatable, Sendable {
    public let code: String
    public let status: UInt16?

    public init(code: String, status: UInt16? = nil) {
        self.code = code
        self.status = status
    }

    public init(_ error: AccountError) {
        switch error {
        case .Api(let code, let status):
            self.init(code: code, status: status)
        }
    }

    public static let network = AccountFailure(code: "network")
    public static let invalidResponse = AccountFailure(code: "invalid_response")

    /// Only the server declaring the session gone makes the stored token
    /// dead weight. A wrong password or a transport failure keeps it.
    public var clearsSession: Bool { code == "unauthenticated" }
}

extension AccountFailure: LocalizedError {
    public var errorDescription: String? { AccountCopy.message(self) }
}

// MARK: - Transport

public struct AccountHTTPResponse: Equatable, Sendable {
    public let status: UInt16
    public let body: Data

    public init(status: UInt16, body: Data) {
        self.status = status
        self.body = body
    }
}

/// The one seam the tests replace: sends the core's request as-is and
/// returns the status plus the fully-read body.
public protocol AccountTransport: Sendable {
    func send(_ request: AccountHttpRequest) async throws -> AccountHTTPResponse
}

public struct URLSessionAccountTransport: AccountTransport {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        self.session = session ?? Self.makeSession()
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration)
    }

    public func send(_ request: AccountHttpRequest) async throws -> AccountHTTPResponse {
        guard let url = URL(string: request.url) else { throw URLError(.badURL) }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        for header in request.headers {
            urlRequest.setValue(header.value, forHTTPHeaderField: header.name)
        }
        if let body = request.body {
            urlRequest.httpBody = Data(body.utf8)
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return AccountHTTPResponse(status: UInt16(http.statusCode), body: data)
    }
}

// MARK: - API

/// One server's account API: the core's request builder, the injected
/// transport, and the core's response parser. Values are typed by the
/// operation, not by the caller re-checking shapes.
public struct AccountAPI: Sendable {
    public let origin: String
    public let token: String?
    private let transport: any AccountTransport

    public init(origin: String, token: String? = nil, transport: any AccountTransport) {
        self.origin = normalizeServerOrigin(origin: origin)
        self.token = token
        self.transport = transport
    }

    public func login(username: String, password: String) async -> Result<LoginSuccess, AccountFailure> {
        switch await request(.login(username: username, password: password), kind: .login) {
        case .success(.login(let value)): return .success(value)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func me() async -> Result<AccountUser, AccountFailure> {
        switch await request(.me, kind: .me) {
        case .success(.me(let user)): return .success(user)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func logout() async -> Result<Void, AccountFailure> {
        switch await request(.logout, kind: .logout) {
        case .success(.unit): return .success(())
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func revokeAllSessions() async -> Result<Void, AccountFailure> {
        switch await request(.revokeAllSessions, kind: .revokeAllSessions) {
        case .success(.unit): return .success(())
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func listHosts() async -> Result<[AccountHost], AccountFailure> {
        switch await request(.listHosts, kind: .listHosts) {
        case .success(.hosts(let hosts)): return .success(hosts)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func requestPairing(hostId: String) async -> Result<PairingOffer, AccountFailure> {
        switch await request(.requestPairing(hostId: hostId), kind: .requestPairing) {
        case .success(.pairingOffer(let offer)): return .success(offer)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    private func request(
        _ op: AccountOp,
        kind: AccountOpKind
    ) async -> Result<AccountValue, AccountFailure> {
        let built = accountRequest(origin: origin, token: token, op: op)
        do {
            let response = try await transport.send(built)
            do {
                let body = String(decoding: response.body, as: UTF8.self)
                return .success(try accountResponse(opKind: kind, status: response.status, body: body))
            } catch let error as AccountError {
                return .failure(AccountFailure(error))
            } catch {
                return .failure(.invalidResponse)
            }
        } catch {
            // No answer at all (DNS, timeout, aborted socket). The core never
            // sees this case; it is the platform's to report.
            return .failure(.network)
        }
    }
}

/// GET /api/me without a session, judged by the core after the platform's
/// five-second budget. The timer stays armed through the body read because
/// the transport returns only a fully-read body.
public struct AccountProbe: Sendable {
    private let transport: any AccountTransport
    private let timeout: Duration

    public init(transport: any AccountTransport, timeout: Duration = .seconds(5)) {
        self.transport = transport
        self.timeout = timeout
    }

    public func probe(origin: String) async -> AccountsProbe {
        let request = accountProbeRequest(origin: origin)
        let response = await withTaskGroup(of: AccountHTTPResponse?.self) { group in
            group.addTask { try? await transport.send(request) }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            defer { group.cancelAll() }
            return await group.next() ?? nil
        }
        guard let response else { return probeVerdict(status: nil, body: nil) }
        return probeVerdict(
            status: response.status,
            body: String(decoding: response.body, as: UTF8.self))
    }
}

// MARK: - Host rows

public enum AccountHostRowStatus: Equatable, Sendable {
    case paired
    case unpaired
    case keyChanged
    /// The host answered 4401 for this device's stored pairing.
    case rejected
}

public enum AccountHostAction: Equatable, Sendable {
    case connect(hostKey: String)
    case pair
    case rePair
}

/// One account host as the UI renders it. The server's pairing verdict is
/// kept beside the status so a disabled button can say why.
public struct AccountHostRow: Identifiable, Equatable, Sendable {
    public let hostId: String
    public let name: String
    public let online: Bool
    public let pairing: AccountHostPairing
    public let status: AccountHostRowStatus
    public let action: AccountHostAction
    public let storedHostKey: String?

    public init(
        hostId: String,
        name: String,
        online: Bool,
        pairing: AccountHostPairing,
        status: AccountHostRowStatus,
        action: AccountHostAction,
        storedHostKey: String?
    ) {
        self.hostId = hostId
        self.name = name
        self.online = online
        self.pairing = pairing
        self.status = status
        self.action = action
        self.storedHostKey = storedHostKey
    }

    public var id: String { hostId }

    public var pairable: Bool { pairing == .available }

    /// Why the pairing button is disabled; nil when it is enabled.
    public var pairingReason: String? {
        pairing == .available ? nil : AccountCopy.pairingReason(pairing)
    }
}

/// The rows plus any account links adopted while matching. changed says
/// whether stored needs saving — adoption is silent bookkeeping.
public struct AccountReconciliation: Equatable, Sendable {
    public let rows: [AccountHostRow]
    public let stored: StoredHosts
    public let changed: Bool
}

public enum AccountHosts {
    /// Pair the server's list against stored pairings, adopt pre-account
    /// twins, and mark hosts this device was refused from. This is the one
    /// pure decision the host list renders.
    public static func reconcile(
        serverOrigin: String,
        hosts: [AccountHost],
        stored: StoredHosts,
        rejectedHostKeys: Set<String>
    ) -> AccountReconciliation {
        let origin = normalizeServerOrigin(origin: serverOrigin)
        let matches = matchAccountHosts(
            serverOrigin: origin,
            hosts: hosts,
            stored: stored.hosts.map { $0.ffi })

        var next = stored
        var changed = false
        for match in matches where match.linkable {
            guard let linked = match.stored,
                  let index = next.hosts.firstIndex(where: { $0.hostKey == linked.hostKey }),
                  next.hosts[index].account == nil
            else { continue }
            next.hosts[index].account = AccountLink(
                serverOrigin: origin,
                hostId: match.host.hostId)
            changed = true
        }

        let rows = matches.map { match -> AccountHostRow in
            let storedKey = match.stored?.hostKey
            let rejected = storedKey.map(rejectedHostKeys.contains) ?? false
            let status: AccountHostRowStatus
            let action: AccountHostAction
            if rejected {
                status = .rejected
                action = .rePair
            } else {
                switch match.status {
                case .paired:
                    status = .paired
                    action = .connect(hostKey: storedKey ?? match.host.noisePublicKey)
                case .unpaired:
                    status = .unpaired
                    action = .pair
                case .keyChanged:
                    status = .keyChanged
                    action = .rePair
                }
            }
            return AccountHostRow(
                hostId: match.host.hostId,
                name: match.host.name,
                online: match.host.online,
                pairing: match.host.pairing,
                status: status,
                action: action,
                storedHostKey: storedKey)
        }

        return AccountReconciliation(rows: rows, stored: next, changed: changed)
    }

    /// A re-pair under a changed key stores a fresh record; the stale linked
    /// one can never connect again, so drop it from the account's identity.
    public static func pruningStale(
        _ stored: StoredHosts,
        serverOrigin: String,
        hostId: String,
        keepingHostKey: String
    ) -> StoredHosts {
        let origin = normalizeServerOrigin(origin: serverOrigin)
        let stale = stored.hosts
            .filter { record in
                guard let account = record.account else { return false }
                return record.hostKey != keepingHostKey
                    && normalizeServerOrigin(origin: account.serverOrigin) == origin
                    && account.hostId == hostId
            }
            .map { $0.hostKey }
        guard !stale.isEmpty else { return stored }

        var next = stored
        next.hosts.removeAll { stale.contains($0.hostKey) }
        if let active = next.activeHostKey, stale.contains(active) {
            next.activeHostKey = next.hosts.contains { $0.hostKey == keepingHostKey }
                ? keepingHostKey
                : nil
        }
        return next
    }
}

// MARK: - Copy

public enum AccountCopy {
    public static let signOutExplanation =
        "退出只是服务端不再替这台设备担保，已配对的宿主不受影响。"

    public static func message(_ failure: AccountFailure) -> String {
        switch failure.code {
        case "invalid_credentials": "用户名或密码不对。"
        case "rate_limited": "尝试次数太多，过几分钟再试。"
        case "network": "连不上服务端，检查地址和网络。"
        case "origin_required": "请输入服务端地址。"
        case "insecure_origin": "服务端地址必须以 https:// 开头。"
        case "invalid_response": "服务端应答不正确，确认地址指向的是 PiNomad 服务端。"
        case "unauthenticated": "登录已失效，请重新登录。"
        case "accounts_disabled": "这个服务端没有开启账号。"
        case "host_offline": "宿主离线。"
        case "host_too_old": "宿主版本太旧，需要在宿主上运行 pinomad upgrade。"
        case "key_mismatch": "宿主的公钥和账号里的记录不一致，请在宿主上重新运行 pinomad join。"
        case "disabled": "宿主关闭了账号担保配对，只能用二维码或配对链接。"
        case "not_joined", "rebinding": "宿主正在切换服务端，等它重启后再试。"
        case "host_timeout": "宿主没有及时应答，再试一次。"
        case "pair_rejected": "宿主拒绝了这台设备。如果之前吊销过，请改用二维码配对。"
        case "invalid_offer": "宿主给出的配对应答无效。"
        case "pairing_not_saved": "已经配对，但这台设备没能保存。"
        default: "出错了（" + failure.code + "）。"
        }
    }

    public static func pairingReason(_ pairing: AccountHostPairing) -> String {
        switch pairing {
        case .available: ""
        case .offline: "宿主离线，连上后才能配对。"
        case .hostTooOld: "宿主版本太旧，需要先运行 pinomad upgrade。"
        case .keyMismatch: "宿主的公钥和账号里的记录不一致，需要先在宿主上重新运行 pinomad join。"
        }
    }
}
