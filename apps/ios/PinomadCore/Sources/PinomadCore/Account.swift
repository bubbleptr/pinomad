import Foundation
import Security

// The server-accounts platform layer (ADR-0022): the core builds each
// request and parses each answer (ADR-0024 §3); this file owns the transport,
// the keychain session, and the pure decisions the UI reads. Nothing here
// logs a token or writes one to UserDefaults.

/// The hosted PiNomad server, where sign-in starts.
public enum OfficialServer {
    public static let origin = "https://app.pinomad.si"
}

// MARK: - Session

/// One live bearer session. The token lives in the keychain and in this
/// value only — never in logs or defaults.
public struct AccountSession: Codable, Equatable, Sendable {
    public var serverOrigin: String
    public var username: String
    public var token: String
    /// Epoch milliseconds, exactly as /api/login reports it.
    public var expiresAt: Double
    /// The account's verified email (ADR-0044 §8); nil on a legacy account
    /// that has none yet, and on records saved before emails existed.
    public var email: String?

    public init(serverOrigin: String, username: String, token: String, expiresAt: Double, email: String? = nil) {
        self.serverOrigin = serverOrigin
        self.username = username
        self.token = token
        self.expiresAt = expiresAt
        self.email = email
    }

    /// The same session with the profile `me` or `setEmail` reported. The
    /// username stays as signed in: it keys this sign-in's records on the
    /// device (known hosts, the push registration).
    public func with(user: AccountUser) -> AccountSession {
        var next = self
        next.email = user.email
        return next
    }

    /// What to show for the account: its email, else the legacy username.
    public var displayName: String { email ?? username }

    /// The same sign-in, whatever its profile says: what an answer must
    /// still match to apply. A profile update doesn't make another session.
    public func isSameSignIn(as other: AccountSession?) -> Bool {
        guard let other else { return false }
        return serverOrigin == other.serverOrigin && token == other.token
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
    /// Optional so records from before ADR-0044 still decode.
    public var email: String?

    public init(
        serverOrigin: String, username: String, token: String? = nil, expiresAt: Double? = nil, email: String? = nil
    ) {
        self.serverOrigin = serverOrigin
        self.username = username
        self.token = token
        self.expiresAt = expiresAt
        self.email = email
    }

    public init(session: AccountSession) {
        self.init(
            serverOrigin: session.serverOrigin,
            username: session.username,
            token: session.token,
            expiresAt: session.expiresAt,
            email: session.email)
    }

    public var session: AccountSession? {
        guard let token, let expiresAt, !token.isEmpty else { return nil }
        return AccountSession(
            serverOrigin: serverOrigin,
            username: username,
            token: token,
            expiresAt: expiresAt,
            email: email)
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

// MARK: - Account device

/// Where this install's account device id lives (ADR-0037 §1).
public protocol AccountDeviceIdStore: Sendable {
    func load() throws -> String?
    func save(_ id: String) throws
}

/// Its own generic-password item beside the account and host items, with
/// the same ThisDeviceOnly lifetime: like the host pairings, it survives a
/// reinstall on this iPhone (the same phone stays the same account device)
/// but never moves to another phone through a backup.
public struct KeychainAccountDeviceIdStore: AccountDeviceIdStore {
    private let service: String
    private let account: String

    public init(
        service: String = "build.kieran.pinomad.device",
        account: String = "pinomad.accountDevice.v1"
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

    public func load() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        switch status {
        case errSecItemNotFound: return nil
        case errSecSuccess:
            guard let data = item as? Data else { throw AccountStoreError.corrupt }
            return String(decoding: data, as: UTF8.self)
        default: throw AccountStoreError.keychain(status)
        }
    }

    public func save(_ id: String) throws {
        let data = Data(id.utf8)
        var request = query
        request[kSecValueData as String] = data
        let status = SecItemAdd(request as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard updated == errSecSuccess else { throw AccountStoreError.keychain(updated) }
        } else if status != errSecSuccess {
            throw AccountStoreError.keychain(status)
        }
    }
}

/// This install's account device id: 128 random bits as base64url,
/// generated once and sent with every sign-in so the server keeps one
/// account device per install across sessions. A tag inside the account,
/// not a credential. A keychain that can't be read or written costs only
/// the reuse: the id still holds for this run, and the next run's sign-in
/// shows up as another device.
public final class AccountDeviceIdSource {
    private let store: any AccountDeviceIdStore
    private var cached: String?

    public init(store: any AccountDeviceIdStore) {
        self.store = store
    }

    public func id() -> String {
        if let cached { return cached }
        if let stored = try? store.load(), Self.isValid(stored) {
            cached = stored
            return stored
        }
        let fresh = Self.generate()
        try? store.save(fresh)
        cached = fresh
        return fresh
    }

    /// What the server accepts (22–64 base64url characters); a stored value
    /// outside it would 400 every sign-in.
    public static func isValid(_ id: String) -> Bool {
        (22...64).contains(id.count) && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    static func generate() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
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

public final class URLSessionAccountTransport: NSObject, AccountTransport, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        self.session = session ?? Self.makeSession()
        super.init()
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
        // The task delegate refuses redirects: a 307 from a trustworthy
        // origin must not carry the password or bearer token to a plaintext
        // host. The 3xx itself comes back and the core reports an API error.
        let (data, response) = try await session.data(for: urlRequest, delegate: self)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return AccountHTTPResponse(status: UInt16(http.statusCode), body: data)
    }
}

extension URLSessionAccountTransport: URLSessionTaskDelegate {
    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
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

    /// `device` ties the session to this install's account device (ADR-0037
    /// §1); older servers ignore it.
    public func login(
        username: String, password: String, device: AccountDeviceClaim? = nil
    ) async -> Result<LoginSuccess, AccountFailure> {
        switch await request(.login(username: username, password: password, device: device), kind: .login) {
        case .success(.login(let value)): return .success(value)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func me() async -> Result<AccountMe, AccountFailure> {
        switch await request(.me, kind: .me) {
        case .success(.me(let me)): return .success(me)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    /// `revoke` also asks every host this device joined through the account
    /// to revoke it (#494); a server that predates it only signs out.
    public func logout(revoke: Bool = false) async -> Result<Void, AccountFailure> {
        switch await request(.logout(revoke: revoke), kind: .logout) {
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

    /// A one-use token and the ready-to-show `pinomad join …` command that
    /// joins a computer to this account (the first-host home, #493).
    public func createJoinToken() async -> Result<JoinToken, AccountFailure> {
        switch await request(.createJoinToken, kind: .createJoinToken) {
        case .success(.joinToken(let token)): return .success(token)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    /// The host waiting behind a code typed on this iPhone (#497). Wrong,
    /// used and expired codes are all 404 `not_found`; repeated wrong ones
    /// lock the account and address out with 429 `rate_limited`.
    public func lookupHostLink(userCode: String) async -> Result<HostLinkRequest, AccountFailure> {
        switch await request(.lookupHostLink(userCode: userCode), kind: .lookupHostLink) {
        case .success(.hostLink(let request)): return .success(request)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    /// Joins the waiting host to this account; it finishes `pinomad join`
    /// on its own.
    public func confirmHostLink(userCode: String) async -> Result<Void, AccountFailure> {
        switch await request(.confirmHostLink(userCode: userCode), kind: .confirmHostLink) {
        case .success(.unit): return .success(())
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func denyHostLink(userCode: String) async -> Result<Void, AccountFailure> {
        switch await request(.denyHostLink(userCode: userCode), kind: .denyHostLink) {
        case .success(.unit): return .success(())
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

    public func registerPushToken(_ token: ApnsPushToken) async -> Result<Void, AccountFailure> {
        switch await request(.registerPushToken(token: token), kind: .registerPushToken) {
        case .success(.unit): return .success(())
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    public func removePushToken(_ token: ApnsPushToken) async -> Result<Void, AccountFailure> {
        switch await request(.removePushToken(token: token), kind: .removePushToken) {
        case .success(.unit): return .success(())
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    /// Keeps this session and signs out the account's others (#450). A
    /// grant instead of the current password also sets a first password on
    /// an account that has none (ADR-0044 §6).
    public func changePassword(current: AccountConfirmation, new: String) async -> Result<Void, AccountFailure> {
        await unit(.changePassword(current: current, newPassword: new))
    }

    /// Deletes the signed-in account and ends this session (#451). 403
    /// `wrong_password` or `invalid_reauth` is a refusal, not a sign-out.
    public func deleteAccount(confirmation: AccountConfirmation) async -> Result<Void, AccountFailure> {
        await unit(.deleteAccount(confirmation: confirmation))
    }

    /// The account's devices (#452); 404 on servers that predate them.
    public func listDevices() async -> Result<[AccountDevice], AccountFailure> {
        switch await request(.listDevices, kind: .listDevices) {
        case .success(.devices(let devices)): return .success(devices)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    /// Signs a device out of the account and asks every host it joined
    /// through the account to revoke it (ADR-0037 §3). 403 `wrong_password`
    /// is a refusal, not a sign-out; 409 `current_device` means sign out
    /// instead.
    public func kickDevice(id: Double, confirmation: AccountConfirmation) async -> Result<Void, AccountFailure> {
        await unit(.kickDevice(id: id, confirmation: confirmation))
    }

    /// Takes a host off the account (#512): the server unbinds it and tells
    /// it to stop connecting. The password again, as for kicking a device
    /// (ADR-0037 §3); 403 `wrong_password` is a refusal, not a sign-out, and
    /// 404 `not_found` also comes from servers that predate it.
    public func removeHost(hostId: String, confirmation: AccountConfirmation) async -> Result<Void, AccountFailure> {
        await unit(.removeHost(hostId: hostId, confirmation: confirmation))
    }

    // MARK: ADR-0044

    /// How this server lets people in.
    public func authMethods() async -> Result<AuthMethods, AccountFailure> {
        await value(.authMethods) { if case .authMethods(let methods) = $0 { methods } else { nil } }
    }

    /// Mails a sign-up code. The answer doesn't say whether the email has
    /// an account; 403 `registration_closed` when the server takes no
    /// sign-ups.
    public func requestSignupCode(email: String) async -> Result<Void, AccountFailure> {
        await unit(.requestSignupCode(email: email))
    }

    /// Creates the account from the mailed code and signs it in, like login.
    public func register(
        email: String, code: String, password: String, device: AccountDeviceClaim? = nil
    ) async -> Result<LoginSuccess, AccountFailure> {
        await value(.register(email: email, code: code, password: password, device: device)) {
            if case .login(let login) = $0 { login } else { nil }
        }
    }

    /// Mails a reset code when the email has an account; the answer doesn't say.
    public func requestPasswordReset(email: String) async -> Result<Void, AccountFailure> {
        await unit(.requestPasswordReset(email: email))
    }

    /// Sets a new password and signs the account out everywhere.
    public func resetPassword(email: String, code: String, password: String) async -> Result<Void, AccountFailure> {
        await unit(.resetPassword(email: email, code: code, password: password))
    }

    /// Mails a code to an email the signed-in account wants to use; 409
    /// `email_taken` when another account has it.
    public func requestEmailCode(email: String, confirmation: AccountConfirmation) async -> Result<Void, AccountFailure> {
        await unit(.requestEmailCode(email: email, confirmation: confirmation))
    }

    /// Makes the mailed-to email the account's; answers the new profile.
    public func setEmail(
        email: String, code: String, confirmation: AccountConfirmation
    ) async -> Result<AccountMe, AccountFailure> {
        await value(.setEmail(email: email, code: code, confirmation: confirmation)) {
            if case .me(let me) = $0 { me } else { nil }
        }
    }

    /// The account's sign-in providers and whether it has a password; 404
    /// on servers from before them.
    public func identities() async -> Result<AccountIdentities, AccountFailure> {
        await value(.identities) { if case .identities(let identities) = $0 { identities } else { nil } }
    }

    /// Removes a provider; 409 `last_method` when nothing else would sign
    /// the account in.
    public func unlinkProvider(_ provider: String, confirmation: AccountConfirmation) async -> Result<Void, AccountFailure> {
        await unit(.unlinkProvider(provider: provider, confirmation: confirmation))
    }

    /// Mails a re-auth code to the account's email; 409 `no_email` without one.
    public func requestReauthCode() async -> Result<Void, AccountFailure> {
        await unit(.requestReauthCode)
    }

    /// Trades the password or a mailed code for a five-minute grant.
    public func reauth(_ proof: ReauthProof) async -> Result<ReauthGrant, AccountFailure> {
        await value(.reauth(proof: proof)) { if case .reauthGrant(let grant) = $0 { grant } else { nil } }
    }

    /// A pending sign-in's provider and email; 404 `not_found` once spent or expired.
    public func pendingSignIn(id: String) async -> Result<PendingSignIn, AccountFailure> {
        await value(.pendingSignIn(id: id)) { if case .pendingSignIn(let pending) = $0 { pending } else { nil } }
    }

    /// Creates the account a pending sign-in asked for. A server that can't
    /// mail needs `password`: 400 `password_required` without one.
    public func createFromPending(
        id: String, password: String? = nil, device: AccountDeviceClaim? = nil
    ) async -> Result<PendingOutcome, AccountFailure> {
        await value(.createFromPending(id: id, password: password, device: device)) {
            if case .pendingOutcome(let outcome) = $0 { outcome } else { nil }
        }
    }

    /// Adds a pending sign-in's provider to this session's account. Answers
    /// a native redirect when a browser flow started it, else nil.
    public func linkPending(id: String, confirmation: AccountConfirmation) async -> Result<String?, AccountFailure> {
        switch await request(.linkPending(id: id, confirmation: confirmation), kind: .linkPending) {
        case .success(.unit): return .success(nil)
        case .success(.redirect(let url)): return .success(url)
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    /// A provider sign-in's one-time code and its PKCE verifier, traded for
    /// a session like a login (ADR-0044 §5).
    public func exchangeOAuthCode(
        code: String, codeVerifier: String, device: AccountDeviceClaim? = nil
    ) async -> Result<LoginSuccess, AccountFailure> {
        await value(.exchangeOAuthCode(code: code, codeVerifier: codeVerifier, device: device)) {
            if case .login(let login) = $0 { login } else { nil }
        }
    }

    /// iOS's own Sign in with Apple. `nonce` is the raw value whose SHA-256
    /// went to Apple; `name` only comes the first time.
    public func appleNative(
        identityToken: String, authorizationCode: String, nonce: String?, name: String?,
        device: AccountDeviceClaim? = nil
    ) async -> Result<AppleNativeOutcome, AccountFailure> {
        await value(.appleNative(
            identityToken: identityToken, authorizationCode: authorizationCode,
            nonce: nonce, name: name, device: device)) {
            if case .appleNative(let outcome) = $0 { outcome } else { nil }
        }
    }

    /// Starts linking Google or GitHub to this session's account (#631):
    /// the one-time page to open in the browser, which comes back to
    /// `native`'s redirect with a code for `completeLink`. 403 `wrong_password` or `invalid_reauth` is a
    /// refusal, not a sign-out.
    public func linkProvider(
        _ provider: String, confirmation: AccountConfirmation, native: NativeLinkRedirect
    ) async -> Result<String, AccountFailure> {
        await value(.linkProvider(provider: provider, confirmation: confirmation, native: native)) {
            if case .redirect(let url) = $0 { url } else { nil }
        }
    }

    /// Finishes a link the browser came back from with `code`: binds it to
    /// this session's account with the verifier behind the challenge sent.
    /// 400 `invalid_grant` for a spent or foreign code, 409 `identity_taken`.
    public func completeLink(code: String, codeVerifier: String) async -> Result<Void, AccountFailure> {
        await unit(.completeLink(code: code, codeVerifier: codeVerifier))
    }

    /// Links the Apple ID from iOS's own sheet to this session's account
    /// (#631). 409 `identity_taken` when another account has it; 401
    /// `session_ended` when the session ended while Apple answered.
    public func linkAppleNative(
        identityToken: String, authorizationCode: String, nonce: String?, name: String?,
        confirmation: AccountConfirmation
    ) async -> Result<Void, AccountFailure> {
        await unit(.linkAppleNative(
            identityToken: identityToken, authorizationCode: authorizationCode,
            nonce: nonce, name: name, confirmation: confirmation))
    }

    private func unit(_ op: AccountOp) async -> Result<Void, AccountFailure> {
        switch await request(op, kind: accountOpKind(op: op)) {
        case .success(.unit): return .success(())
        case .failure(let failure): return .failure(failure)
        default: return .failure(.invalidResponse)
        }
    }

    private func value<T>(_ op: AccountOp, _ pick: (AccountValue) -> T?) async -> Result<T, AccountFailure> {
        switch await request(op, kind: accountOpKind(op: op)) {
        case .success(let value): return pick(value).map(Result.success) ?? .failure(.invalidResponse)
        case .failure(let failure): return .failure(failure)
        }
    }

    private func request(
        _ op: AccountOp,
        kind: AccountOpKind
    ) async -> Result<AccountValue, AccountFailure> {
        let built = accountRequest(origin: origin, token: token, op: op)
        // Defense in depth: even an API value built somewhere other than the
        // login form never sends credentials over plaintext.
        guard isSecureServerOrigin(origin: built.url) else {
            return .failure(AccountFailure(code: "insecure_origin"))
        }
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
        guard isSecureServerOrigin(origin: request.url) else {
            return .unreachable
        }
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
    /// False when the server can't ask this host to revoke a device
    /// (ADR-0037 §5); nil from servers older than #452.
    public let deviceReports: Bool?

    public init(
        hostId: String,
        name: String,
        online: Bool,
        pairing: AccountHostPairing,
        status: AccountHostRowStatus,
        action: AccountHostAction,
        storedHostKey: String?,
        deviceReports: Bool? = nil
    ) {
        self.hostId = hostId
        self.name = name
        self.online = online
        self.pairing = pairing
        self.status = status
        self.action = action
        self.storedHostKey = storedHostKey
        self.deviceReports = deviceReports
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
    /// Account hosts the shared eligibility rule allows this device to
    /// register without asking (ADR-0035 §5). The app still checks the
    /// server's pairing verdict before starting a handshake.
    public let autoRegisterHostIds: [String]
}

public enum AccountHosts {
    /// Pair the server's list against stored pairings, adopt pre-account
    /// twins, and mark hosts this device was refused from. This is the one
    /// pure decision the host list renders.
    public static func reconcile(
        serverOrigin: String,
        hosts: [AccountHost],
        stored: StoredHosts,
        rejectedHostKeys: Set<String>,
        declined: [AccountHostRef] = [],
        storedRead: Bool = true
    ) -> AccountReconciliation {
        let origin = normalizeServerOrigin(origin: serverOrigin)
        let matches = matchAccountHosts(
            serverOrigin: origin,
            hosts: hosts,
            stored: stored.hosts.map { $0.ffi },
            declined: declined,
            storedRead: storedRead)

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
                storedHostKey: storedKey,
                deviceReports: match.host.deviceReports)
        }

        return AccountReconciliation(
            rows: rows,
            stored: next,
            changed: changed,
            autoRegisterHostIds: matches.filter(\.autoRegister).map(\.host.hostId))
    }

    /// The hosts a shared-device sign-out forgets (#494): those whose key
    /// came from `serverOrigin`'s own offer. A link `reconcile` adopted onto
    /// a QR pairing isn't vouched, so that pairing stays. With `hostId`, only
    /// that host's: what removing it from the account forgets (#512).
    public static func vouchedHostKeys(serverOrigin: String, hostId: String? = nil, hosts: [HostRecord]) -> [String] {
        let origin = normalizeServerOrigin(origin: serverOrigin)
        return hosts.compactMap { host in
            guard let link = host.account, link.vouched == true,
                  normalizeServerOrigin(origin: link.serverOrigin) == origin,
                  hostId == nil || link.hostId == hostId
            else { return nil }
            return host.hostKey
        }
    }

    /// What a 404 to removing `hostId` means (#512): gone already, or a
    /// server that predates removal. `listedAfter` is the host list asked for
    /// after that answer, nil when there is none: one already in flight may
    /// predate it, and a failed one says nothing. Nil means removed.
    public static func removeHostNotFound(hostId: String, listedAfter: [String]?) -> AccountFailure? {
        guard let listedAfter else { return AccountFailure(code: "remove_host_unconfirmed") }
        return listedAfter.contains(hostId) ? AccountFailure(code: "remove_host_unsupported", status: 404) : nil
    }
}

// MARK: - Devices

extension AccountDevice: Identifiable {}

extension AccountDevice {
    /// Remove is for another device still on the account: this one signs
    /// out instead (the server answers 409), and a removed one is gone.
    public var removable: Bool { !current && kickedAt == nil }
}

// MARK: - Copy

/// How this iPhone holds a host being removed from the account (#512).
public enum RemovedHostPairing: Sendable {
    case none
    /// Paired through the account: removing it forgets it here too.
    case account
    /// Paired by QR code: that pairing stays.
    case qrCode
}

public enum AccountCopy {
    public static func deviceHostState(_ state: AccountDeviceHostState) -> String {
        switch state {
        case .registered: "Registered"
        case .revoking: "Waiting for the host"
        case .revoked: "Revoked"
        }
    }

    /// What removing `name` does. A host that doesn't report devices never
    /// shows up in a device's hosts, so there's no telling whether this
    /// device joined it: every such host is named (ADR-0037 §5).
    public static func removeDeviceExplanation(name: String, hosts: [AccountHostRow]) -> String {
        let base = "This signs \(name) out of your account and asks each host it joined through your account to revoke it. Hosts that are offline revoke it when they reconnect."
        let unreachable = hosts.filter { $0.deviceReports == false }.map(\.name)
        switch unreachable.count {
        case 0: return base
        case 1: return base + " \(unreachable[0]) can't be asked. If \(name) joined it, revoke it on that host."
        default:
            let names = unreachable.dropLast().joined(separator: ", ") + " and " + unreachable[unreachable.count - 1]
            return base + " \(names) can't be asked. If \(name) joined them, revoke it on each one."
        }
    }

    /// What removing `name` from the account does (#512), and what this
    /// iPhone keeps: it forgets a pairing the account issued, not a QR one.
    public static func removeHostExplanation(name: String, server: String, pairedHere: RemovedHostPairing) -> String {
        let base = "This takes \(name) off your account and it stops connecting through \(server). Only running pinomad up on \(name) brings it back."
        switch pairedHere {
        case .none: return base
        case .account: return base + " This iPhone forgets it too."
        case .qrCode: return base + " This iPhone stays paired with it by QR code; forget it in Settings to stop connecting."
        }
    }

    public static func deleteAccountExplanation(server: String) -> String {
        "This deletes your account on \(server) and signs you out everywhere. Hosts on your account are disconnected from the server; run pinomad join on each to connect it again. This iPhone and your other devices stay paired with their hosts until you revoke them there."
    }

    public static let accountDeletedNotice =
        "Account deleted. This iPhone is still paired with your hosts. To remove it, revoke it in each host's Devices."

    public static let signOutExplanation =
        "Signing out stops the server from vouching for this device and from delivering its notifications. Paired hosts stay paired unless you remove this iPhone from them."

    /// The shared-device choice beside Sign out (#494).
    public static let signOutRevokeExplanation =
        "For a shared or borrowed iPhone: each host it joined through your account revokes it, and it forgets them. Hosts paired with a QR code stay."

    /// The warning after a sign-out request failed. On this device an
    /// unauthenticated answer just means the local token was already dead;
    /// for "everywhere" it proves nothing about the other sessions, and with
    /// `revoke` a dead session asked no host to revoke anything.
    public static func signOutWarning(everywhere: Bool, revoke: Bool = false, failure: AccountFailure?) -> String? {
        guard let failure, everywhere || revoke || !failure.clearsSession else { return nil }
        if everywhere { return "Other devices may still be signed in. Sign in and try Sign out everywhere again." }
        return revoke
            ? "This iPhone forgot its account hosts, but the server didn't confirm asking them to revoke it. Remove it from another device, or revoke it on each host."
            : "Signed out on this device, but the server didn't confirm. The session will expire on its own within 30 days."
    }

    public static func message(_ failure: AccountFailure) -> String {
        switch failure.code {
        case "invalid_credentials": "Wrong email or password."
        case "rate_limited": "Too many attempts. Wait a few minutes and try again."
        case "network": "Can't reach the server. Check the address and your connection."
        case "origin_required": "Enter the server address."
        case "insecure_origin": "The server address must start with https://."
        case "invalid_response": "The server's response wasn't valid. Make sure the address points to a PiNomad server."
        case "unauthenticated": "You were signed out. Sign in again."
        case "accounts_disabled": "This server doesn't have accounts turned on."
        case "host_offline": "The host is offline."
        case "host_too_old": "The host needs an update (run pinomad upgrade on it)."
        case "key_mismatch": "The host's key doesn't match its account record. Run pinomad join on it again."
        case "disabled": "The host doesn't accept account pairing. Pair with a QR code or pairing link instead."
        case "not_joined", "rebinding": "The host is moving between servers. Try again after it restarts."
        case "host_timeout": "The host didn't answer in time. Try again."
        case "pair_rejected": "The host refused this device. If you revoked it before, pair it with a QR code instead."
        case "invalid_offer": "The host's pairing offer was invalid."
        case "pairing_not_saved": "Paired, but this device couldn't save the pairing."
        case "wrong_password": "The password is wrong."
        case "weak_password": "Use a password of at least 12 characters."
        // ADR-0044: email codes, sign-in methods, provider sign-in.
        case "invalid_code": "That code is wrong or has expired. Check the latest email, or send a new code."
        case "invalid_email": "Enter a valid email address."
        case "registration_closed": "This server isn't taking new accounts."
        case "email_unavailable": "This server can't send email right now. Try again later."
        case "email_taken": "Another account already uses that email."
        case "password_required": "Choose a password for the account."
        case "invalid_reauth": "The confirmation expired. Confirm again."
        case "last_method": "This is the only way to sign in to your account. Add another before removing it."
        case "identity_taken": "That account is already linked to another PiNomad account."
        case "session_ended": "You were signed out before linking finished. Sign in and try again."
        case "no_email": "Your account has no email to send a code to."
        case "no_verified_email": "The provider didn't give a verified email. Sign in another way, or verify your email there first."
        case "superseded": "You signed in another way while this sign-in was waiting."
        case "access_denied": "Sign-in was cancelled."
        case "invalid_state": "This sign-in expired or was started elsewhere. Start again."
        case "exchange_failed", "invalid_token", "invalid_grant": "The provider's answer couldn't be checked. Try again."
        case "not_found": "This sign-in expired. Start again."
        case "current_device": "That's the device you're using. Sign out instead."
        // Set by the app: a 404 for a host the list fetched after it still has.
        case "remove_host_unsupported": "This server can't remove hosts. Run pinomad leave on the host, or update the server."
        // Set by the app: a 404 with no list fetched after it to tell why.
        case "remove_host_unconfirmed": "Couldn't confirm the host was removed. Try again."
        default: "Something went wrong (" + failure.code + ")."
        }
    }

    /// Linking `provider` from settings (#631) refused: names the provider
    /// where the general wording can't.
    public static func linkMessage(_ failure: AccountFailure, provider: String) -> String {
        switch failure.code {
        case "identity_taken": "That \(provider) account is already linked to another PiNomad account."
        case "access_denied": "Linking \(provider) was cancelled."
        case "invalid_state": "This link expired or was started elsewhere. Start again."
        default: message(failure)
        }
    }

    public static func pairingReason(_ pairing: AccountHostPairing) -> String {
        switch pairing {
        case .available: ""
        case .offline: "The host is offline. It can be paired once it's back online."
        case .hostTooOld: "The host needs an update. Run pinomad upgrade on it first."
        case .keyMismatch: "The host's key doesn't match its account record. Run pinomad join on it again first."
        }
    }
}
