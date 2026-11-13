import CryptoKit
import Foundation
import Observation

// Signing in with a provider, and confirming account changes (ADR-0044 §5,
// §6), as decisions the app only wires up. The races Web hit and dureview
// caught live here, where they're tested: a sign-in overtaken by another
// one, an answer for a session that's gone, and a grant that lapsed while
// its form was open. Nothing here logs a code, token, grant or password.

// MARK: - Superseded sign-in

/// One sign-in attempt: the generation it started in and the session that
/// was active then.
public struct SignInTicket: Equatable, Sendable {
    let generation: UInt64
    let session: AccountSession?
}

/// Moves on with every sign-in attempt (password, sign-up, Apple, a browser
/// flow, a pending create) and every session end, so an attempt that waited
/// — on a browser sheet, on Apple, on the server — can tell it was overtaken.
@MainActor
public final class SignInGate {
    private var generation: UInt64 = 0

    public init() {}

    public func begin(active: AccountSession?) -> SignInTicket {
        generation &+= 1
        return SignInTicket(generation: generation, session: active)
    }

    /// A session ended: every attempt still waiting is stale.
    public func invalidate() {
        generation &+= 1
    }

    /// Nothing else started or ended since `ticket`, and the session active
    /// now is the one that was active then (a profile update aside).
    public func isCurrent(_ ticket: SignInTicket, active: AccountSession?) -> Bool {
        guard ticket.generation == generation else { return false }
        guard let started = ticket.session else { return active == nil }
        return started.isSameSignIn(as: active)
    }
}

// MARK: - Browser sign-in (Google, GitHub)

/// A native client's PKCE pair and state for one provider sign-in.
public struct OAuthPKCE: Sendable {
    public let verifier: String
    public let state: String

    public init(verifier: String, state: String) {
        self.verifier = verifier
        self.state = state
    }

    public static func random() -> OAuthPKCE {
        OAuthPKCE(verifier: randomBase64URL(bytes: 32), state: randomBase64URL(bytes: 16))
    }

    /// RFC 7636 S256.
    public var challenge: String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
}

public enum NativeOAuth {
    public static let callbackScheme = "pinomad"
    public static let redirectURI = "pinomad://auth"

    /// `pinomad://auth…`: a provider sign-in coming back. It belongs to the
    /// browser session that started it, never to the pairing deep link.
    public static func isCallback(_ url: URL) -> Bool {
        url.scheme?.lowercased() == callbackScheme && url.host() == "auth"
    }

    /// Where the browser starts: the server's provider redirect for a
    /// native client (ADR-0044 §5).
    public static func startURL(origin: String, provider: String, pkce: OAuthPKCE) -> URL? {
        let base = normalizeServerOrigin(origin: origin)
        guard let path = provider.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              var components = URLComponents(string: "\(base)/api/oauth/\(path)/start")
        else { return nil }
        components.queryItems = [
            URLQueryItem(name: "client", value: "native"),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "state", value: pkce.state),
        ]
        // `+` and the URI's own `:`/`/` must reach the server as written.
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: ":", with: "%3A")
            .replacingOccurrences(of: "/", with: "%2F")
        return components.url
    }

    /// The one-time code the callback carries, once it's this flow's: a
    /// state that doesn't match is `invalid_state`, and the server's
    /// `error=` reason passes through.
    public static func code(from callback: URL, pkce: OAuthPKCE) -> Result<String, AccountFailure> {
        guard isCallback(callback),
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
        else { return .failure(AccountFailure(code: "invalid_state")) }
        let query = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        guard query["state"] == pkce.state else { return .failure(AccountFailure(code: "invalid_state")) }
        if let error = query["error"], !error.isEmpty { return .failure(AccountFailure(code: error)) }
        guard let code = query["code"], !code.isEmpty else { return .failure(.invalidResponse) }
        return .success(code)
    }
}

// MARK: - Linking a provider from settings (#631)

public enum ProviderLinkResult: Equatable, Sendable {
    case linked
    case failed(AccountFailure)
    /// The reader closed the browser sheet or the Apple sheet.
    case cancelled
    /// Another sign-in or link started, or the session ended or changed,
    /// meanwhile: the result is dropped.
    case superseded
}

@MainActor
public enum ProviderLink {
    /// Google or GitHub: `start` asks the server for the one-time page with
    /// this flow's redirect, `authenticate` opens it in the browser (nil when
    /// the reader cancelled), the callback must carry this state, and
    /// `complete` trades its code with the verifier only this app holds —
    /// the server binds nothing before that. Checked against the gate after
    /// each step, so a link that finishes after a sign-out or another
    /// sign-in is dropped, and its code never traded.
    public static func web(
        pkce: OAuthPKCE = .random(),
        gate: SignInGate,
        active: () -> AccountSession?,
        start: (NativeLinkRedirect) async -> Result<String, AccountFailure>,
        authenticate: (URL) async -> URL?,
        complete: (_ code: String, _ verifier: String) async -> Result<Void, AccountFailure>
    ) async -> ProviderLinkResult {
        let ticket = gate.begin(active: active())
        let redirect = NativeLinkRedirect(
            redirectUri: NativeOAuth.redirectURI, codeChallenge: pkce.challenge, state: pkce.state)
        let page: String
        switch await start(redirect) {
        case .success(let value): page = value
        case .failure(let failure):
            return gate.isCurrent(ticket, active: active()) ? .failed(failure) : .superseded
        }
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        guard let url = URL(string: page) else { return .failed(.invalidResponse) }
        let callback = await authenticate(url)
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        guard let callback else { return .cancelled }
        let code: String
        switch NativeOAuth.code(from: callback, pkce: pkce) {
        case .success(let value): code = value
        case .failure(let failure): return .failed(failure)
        }
        let result = await complete(code, pkce.verifier)
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        switch result {
        case .success: return .linked
        case .failure(let failure): return .failed(failure)
        }
    }

    /// Apple once its sheet answered: dropped if `ticket` (taken when the
    /// button was pressed) went stale while the sheet was up or while the
    /// server checked the token.
    public static func apple(
        ticket: SignInTicket,
        gate: SignInGate,
        active: () -> AccountSession?,
        finish: () async -> Result<Void, AccountFailure>
    ) async -> ProviderLinkResult {
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        let result = await finish()
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        switch result {
        case .success: return .linked
        case .failure(let failure): return .failed(failure)
        }
    }
}

// MARK: - Sign in with Apple

public enum AppleNonce {
    /// The raw nonce the server gets; Apple gets its hash.
    public static func random() -> String {
        randomBase64URL(bytes: 32)
    }

    /// What goes in the Apple request: SHA-256 as lowercase hex, which the
    /// server recomputes from the raw value.
    public static func sha256Hex(_ raw: String) -> String {
        SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Outcomes

public enum ProviderSignInResult: Equatable, Sendable {
    case signedIn(LoginSuccess)
    /// Sign in with Apple found no account: the native "no account yet" step.
    case noAccount(pending: String, email: String?)
    case failed(AccountFailure)
    /// The reader closed the browser sheet or the Apple sheet.
    case cancelled
    /// Another sign-in started, or a session started or ended, meanwhile:
    /// the result is dropped.
    case superseded
}

@MainActor
public enum ProviderSignIn {
    /// Google or GitHub in the system browser: the server's start URL, the
    /// callback checked against this flow's state, then the code traded
    /// with its verifier. Checked against the gate when the browser comes
    /// back and again after the trade. `authenticate` returns nil when the
    /// reader cancelled.
    public static func web(
        provider: String,
        origin: String,
        pkce: OAuthPKCE = .random(),
        gate: SignInGate,
        active: () -> AccountSession?,
        authenticate: (URL) async -> URL?,
        exchange: (_ code: String, _ verifier: String) async -> Result<LoginSuccess, AccountFailure>
    ) async -> ProviderSignInResult {
        let ticket = gate.begin(active: active())
        guard let start = NativeOAuth.startURL(origin: origin, provider: provider, pkce: pkce) else {
            return .failed(.invalidResponse)
        }
        let callback = await authenticate(start)
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        guard let callback else { return .cancelled }
        let code: String
        switch NativeOAuth.code(from: callback, pkce: pkce) {
        case .success(let value): code = value
        case .failure(let failure): return .failed(failure)
        }
        let result = await exchange(code, pkce.verifier)
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        switch result {
        case .success(let login): return .signedIn(login)
        case .failure(let failure): return .failed(failure)
        }
    }

    /// Sign in with Apple once Apple answered: dropped if `ticket` (taken
    /// when the button was pressed) went stale while Apple's sheet was up,
    /// or while the server checked the token.
    public static func apple(
        ticket: SignInTicket,
        gate: SignInGate,
        active: () -> AccountSession?,
        finish: () async -> Result<AppleNativeOutcome, AccountFailure>
    ) async -> ProviderSignInResult {
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        let result = await finish()
        guard gate.isCurrent(ticket, active: active()) else { return .superseded }
        switch result {
        case .success(.signedIn(let login)): return .signedIn(login)
        case .success(.noAccount(let pending, let email)): return .noAccount(pending: pending, email: email)
        case .failure(let failure): return .failed(failure)
        }
    }
}

// MARK: - Late answers

@MainActor
public enum AccountScope {
    /// Runs `call` for the session active now, and hands its answer to
    /// `apply` only while that same sign-in is still active: an answer for
    /// a session that ended (or was replaced) must not touch the next one.
    /// Nil when no session is active.
    @discardableResult
    public static func run<T>(
        active: () -> AccountSession?,
        _ call: (AccountSession) async -> T,
        apply: (T, AccountSession) -> Void
    ) async -> T? {
        guard let sent = active() else { return nil }
        let value = await call(sent)
        if let current = active(), sent.isSameSignIn(as: current) {
            apply(value, current)
        }
        return value
    }
}

// MARK: - Confirmation step

/// The second check a guarded action asks for (ADR-0044 §6): the password
/// on an account that has one, else a code mailed to the account's email,
/// traded for a grant that's reused for its five minutes. The password is
/// sent each time and never kept past the form.
@MainActor
@Observable
public final class IdentityConfirmation {
    public enum Method: Equatable, Sendable {
        case loading
        case password
        case code
    }

    public private(set) var method = Method.loading
    public var password = ""
    public var code = ""
    public private(set) var sent = false
    public private(set) var sending = false
    public private(set) var sendError: AccountFailure?
    /// A refused password or code, shown on the step's own field until
    /// it's edited or tried again.
    public private(set) var fieldError: AccountFailure?
    /// The grant and the code it was traded for: a changed code drops it.
    private var grant: (value: ReauthGrant, code: String)?

    public init() {}

    /// `hasPassword` from the account's sign-in methods; nil when they
    /// couldn't be listed (an older server), which still takes the password.
    public func load(hasPassword: Bool?) {
        method = hasPassword == false ? .code : .password
    }

    /// Enough is filled in to try.
    public var ready: Bool {
        switch method {
        case .loading: false
        case .password: !password.isEmpty
        case .code: sent && !trimmedCode.isEmpty
        }
    }

    private var trimmedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// "Send code" (or "Resend code").
    public func send(_ request: () async -> Result<Void, AccountFailure>) async {
        guard !sending else { return }
        sending = true
        sendError = nil
        let result = await request()
        sending = false
        switch result {
        case .success: sent = true
        case .failure(let failure): sendError = failure
        }
    }

    /// The confirmation to send with the action: the password, or a grant —
    /// the one already traded for this code while it lasts, else a new one.
    public func confirm(
        now: Date = .now,
        reauth: (ReauthProof) async -> Result<ReauthGrant, AccountFailure>
    ) async -> Result<AccountConfirmation, AccountFailure> {
        switch method {
        case .loading: return .failure(AccountFailure(code: "invalid_reauth"))
        case .password: return .success(.password(password))
        case .code: break
        }
        let code = trimmedCode
        // A few seconds' margin: one that lapses in flight is refused anyway.
        if let grant, grant.code == code, grant.value.expiresAt > now.timeIntervalSince1970 * 1000 + 10_000 {
            return .success(.reauth(grant.value.reauth))
        }
        grant = nil
        switch await reauth(.code(code)) {
        case .success(let value):
            grant = (value, code)
            return .success(.reauth(value.reauth))
        case .failure(let failure):
            return .failure(failure)
        }
    }

    /// Takes a refused password or code onto this step's field when the
    /// step was the one asking: a password is sent with every action, a
    /// code only when it was traded for a grant (`duringConfirm`) — a
    /// reused grant means the code was the action's own. True when taken.
    @discardableResult
    public func claim(_ failure: AccountFailure, duringConfirm: Bool) -> Bool {
        let field = AccountCopy.field(failure)
        let asked = switch method {
        case .password: field == .password
        case .code: duringConfirm && field == .code
        case .loading: false
        }
        if asked { fieldError = failure }
        return asked
    }

    public func clearFieldError() {
        fieldError = nil
    }

    /// The action came back refused. `invalid_reauth` (the grant lapsed or
    /// belongs to another session) drops the grant and the spent code, so
    /// the step shows Send code again; the action's own fields stay as
    /// typed. True when the step has to be shown again.
    @discardableResult
    public func refused(_ failure: AccountFailure) -> Bool {
        guard failure.code == "invalid_reauth" else { return false }
        grant = nil
        code = ""
        sent = false
        return true
    }
}

// MARK: - Helpers

private func randomBase64URL(bytes count: Int) -> String {
    var generator = SystemRandomNumberGenerator()
    let bytes = (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return base64URL(Data(bytes))
}

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
