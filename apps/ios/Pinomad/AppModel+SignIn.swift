import AuthenticationServices
import Foundation
import PinomadCore

/// Sign in with Apple found no PiNomad account (ADR-0044 §4): the pending id
/// the app finishes it with, on the server that answered.
struct ApplePendingSignIn: Identifiable, Equatable {
    let id: String
    let serverOrigin: String
    let email: String?
}

/// ADR-0044 on iOS: email sign-up and reset, Google and GitHub in the system
/// browser, Sign in with Apple, the account's email and sign-in methods, and
/// the re-auth confirmation. Every sign-in goes through the sign-in gate and
/// every answer that changes the profile through `AccountScope`, so a late
/// one never lands on a session it doesn't belong to.
extension AppModel {
    // MARK: Before a session

    private func anonymousAPI(_ origin: String) -> Result<AccountAPI, AccountFailure> {
        checkedAccountOrigin(origin).map { AccountAPI(origin: $0, transport: accountTransport) }
    }

    /// How `origin` lets people in; nil when it didn't say (the email form
    /// still works without it).
    func accountAuthMethods(_ origin: String) async -> AuthMethods? {
        let server = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSecureServerOrigin(origin: server) else { return nil }
        return try? await AccountAPI(origin: server, transport: accountTransport).authMethods().get()
    }

    func accountRequestSignupCode(origin: String, email: String) async -> AccountFailure? {
        switch anonymousAPI(origin) {
        case .failure(let failure): failure
        case .success(let api): await api.requestSignupCode(email: email).failure
        }
    }

    func accountRequestPasswordReset(origin: String, email: String) async -> AccountFailure? {
        switch anonymousAPI(origin) {
        case .failure(let failure): failure
        case .success(let api): await api.requestPasswordReset(email: email).failure
        }
    }

    func accountResetPassword(origin: String, email: String, code: String, password: String) async -> AccountFailure? {
        switch anonymousAPI(origin) {
        case .failure(let failure): failure
        case .success(let api): await api.resetPassword(email: email, code: code, password: password).failure
        }
    }

    /// Creates the account from the mailed code and signs it in.
    func accountRegister(origin: String, email: String, code: String, password: String) async -> AccountFailure? {
        await accountSignIn(origin: origin, remembering: email) { api, device in
            await api.register(email: email, code: code, password: password, device: device)
        }
    }

    // MARK: Providers

    /// Google or GitHub in the system browser (ADR-0044 §5). `authenticate`
    /// runs the browser session and answers its callback, nil when the
    /// reader cancelled.
    func accountProviderSignIn(
        origin: String, provider: String, authenticate: (URL) async -> URL?
    ) async -> AccountFailure? {
        let api: AccountAPI
        switch anonymousAPI(origin) {
        case .success(let value): api = value
        case .failure(let failure): return failure
        }
        accountError = nil
        let device = accountDeviceClaim()
        let result = await ProviderSignIn.web(
            provider: provider,
            origin: api.origin,
            gate: signInGate,
            active: { self.accountSession },
            authenticate: authenticate,
            exchange: { code, verifier in
                await api.exchangeOAuthCode(code: code, codeVerifier: verifier, device: device)
            })
        return await settle(result, origin: api.origin)
    }

    /// The Apple button was pressed: the attempt starts now, so one that
    /// finishes later can tell whether it was overtaken.
    func beginAppleSignIn() -> (ticket: SignInTicket, nonce: String) {
        (signInGate.begin(active: accountSession), AppleNonce.random())
    }

    /// Apple answered: hand the credential to the server. No account yet
    /// opens the native "no account yet" step.
    func finishAppleSignIn(
        origin: String, ticket: SignInTicket, nonce: String, credential: ASAuthorizationAppleIDCredential
    ) async -> AccountFailure? {
        let api: AccountAPI
        switch anonymousAPI(origin) {
        case .success(let value): api = value
        case .failure(let failure): return failure
        }
        guard let identityToken = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
              let authorizationCode = credential.authorizationCode.flatMap({ String(data: $0, encoding: .utf8) })
        else { return AccountFailure(code: "invalid_token") }
        // Apple shares the name only the first time; the server keeps it.
        let name = credential.fullName
            .map { PersonNameComponentsFormatter.localizedString(from: $0, style: .default) }
            .flatMap { $0.isEmpty ? nil : $0 }
        let device = accountDeviceClaim()
        accountError = nil
        let result = await ProviderSignIn.apple(ticket: ticket, gate: signInGate, active: { self.accountSession }) {
            await api.appleNative(
                identityToken: identityToken, authorizationCode: authorizationCode,
                nonce: nonce, name: name, device: device)
        }
        return await settle(result, origin: api.origin)
    }

    private func settle(_ result: ProviderSignInResult, origin: String) async -> AccountFailure? {
        switch result {
        case .signedIn(let login):
            return await adoptAccountSession(origin: origin, login: login)
        case .noAccount(let pending, let email):
            accountApplePending = ApplePendingSignIn(id: pending, serverOrigin: origin, email: email)
            return nil
        case .failed(let failure):
            return failure
        case .cancelled:
            return nil
        case .superseded:
            // Whatever signed in (or out) meanwhile wins; say so only while
            // the form is still up.
            return accountSession == nil ? AccountFailure(code: "superseded") : nil
        }
    }

    // MARK: No account yet (Apple)

    /// "Create account": the account the pending sign-in asked for, signed
    /// in. A server that can't mail codes needs a password first.
    func accountCreateFromPending(_ pending: ApplePendingSignIn, password: String?) async -> AccountFailure? {
        let api: AccountAPI
        switch anonymousAPI(pending.serverOrigin) {
        case .success(let value): api = value
        case .failure(let failure): return failure
        }
        // A sign-in like any other: an older one still waiting must not land after it.
        let ticket = signInGate.begin(active: accountSession)
        accountBusy = true
        defer { accountBusy = false }
        let result = await api.createFromPending(id: pending.id, password: password, device: accountDeviceClaim())
        guard signInGate.isCurrent(ticket, active: accountSession) else { return AccountFailure(code: "superseded") }
        switch result {
        case .success(.signedIn(let login)):
            if let failure = await adoptAccountSession(origin: api.origin, login: login) { return failure }
            accountApplePending = nil
            return nil
        // A browser flow's redirect: not what a direct (Apple) sign-in answers.
        case .success(.redirect): return .invalidResponse
        case .failure(let failure): return failure
        }
    }

    /// "I already have an account": sign in with the email and password,
    /// then add Apple to that account confirmed by the same password.
    func accountSignInAndLinkPending(_ pending: ApplePendingSignIn, email: String, password: String) async -> AccountFailure? {
        if accountSession == nil {
            if let failure = await accountLogin(origin: pending.serverOrigin, username: email, password: password) {
                return failure
            }
        }
        let result = await scopedAccountCall { api in
            await api.linkPending(id: pending.id, confirmation: .password(password))
        }
        switch result {
        case .success:
            accountApplePending = nil
            Task { [weak self] in await self?.accountRefreshIdentities() }
            return nil
        case .failure(let failure):
            return failure
        }
    }

    // MARK: Session-scoped calls

    /// One account call for the session active now. Its answer reaches
    /// `onSuccess` only while that session is still the active one, and an
    /// `unauthenticated` signs it out; a late answer touches nothing.
    @discardableResult
    func scopedAccountCall<T>(
        _ call: (AccountAPI) async -> Result<T, AccountFailure>,
        onSuccess: (T, AccountSession) -> Void = { _, _ in }
    ) async -> Result<T, AccountFailure> {
        #if DEBUG
        if devHostsInjected { return .failure(AccountFailure(code: "unauthenticated")) }
        #endif
        let result = await AccountScope.run(active: { self.accountSession }) { session in
            await call(self.accountAPI(for: session))
        } apply: { result, _ in
            switch result {
            case .success(let value):
                if let session = self.accountSession { onSuccess(value, session) }
            case .failure(let failure) where failure.clearsSession:
                self.accountSignOutWarning = self.endAccountSession(notice: AccountCopy.message(failure))
            case .failure:
                break
            }
        }
        return result ?? .failure(AccountFailure(code: "unauthenticated"))
    }

    /// Whether the account still owes an email (ADR-0044 §8), and its
    /// current email.
    func accountRefreshProfile() async {
        guard accountAPI() != nil else { return }
        await scopedAccountCall { api in await api.me() } onSuccess: { me, session in
            self.applyProfile(me, to: session)
        }
    }

    private func applyProfile(_ me: AccountMe, to session: AccountSession) {
        accountNeedsEmail = me.needsEmail
        let updated = session.with(user: me.user)
        guard updated != session else { return }
        let record = AccountRecord(session: updated)
        accountRecord = record
        try? accountStore.save(record)
    }

    func accountRefreshIdentities() async {
        guard accountAPI() != nil else { return }
        let asked = accountSession
        accountIdentitiesError = nil
        let result = await scopedAccountCall { api in await api.identities() } onSuccess: { identities, _ in
            self.accountIdentities = identities
            self.accountIdentitiesUnsupported = false
        }
        // A failure for a session that has since ended belongs to before.
        guard case .failure(let failure) = result, let asked, asked.isSameSignIn(as: accountSession),
              !failure.clearsSession else { return }
        if failure.status == 404 {
            accountIdentitiesUnsupported = true
        } else if accountIdentities == nil {
            accountIdentitiesError = AccountCopy.message(failure)
        }
    }

    func accountRequestReauthCode() async -> Result<Void, AccountFailure> {
        await scopedAccountCall { api in await api.requestReauthCode() }
    }

    func accountReauth(_ proof: ReauthProof) async -> Result<ReauthGrant, AccountFailure> {
        await scopedAccountCall { api in await api.reauth(proof) }
    }

    /// Mails a code to the email the account wants to use.
    func accountRequestEmailCode(email: String, confirmation: AccountConfirmation) async -> AccountFailure? {
        await scopedAccountCall { api in await api.requestEmailCode(email: email, confirmation: confirmation) }.failure
    }

    /// Makes it the account's email; ends the add-an-email hold.
    func accountSetEmail(email: String, code: String, confirmation: AccountConfirmation) async -> AccountFailure? {
        await scopedAccountCall { api in
            await api.setEmail(email: email, code: code, confirmation: confirmation)
        } onSuccess: { me, session in
            self.applyProfile(me, to: session)
            self.accountNeedsEmail = false
        }.failure
    }

    func accountUnlinkProvider(_ provider: String, confirmation: AccountConfirmation) async -> AccountFailure? {
        let failure = await scopedAccountCall { api in
            await api.unlinkProvider(provider, confirmation: confirmation)
        }.failure
        if failure == nil { await accountRefreshIdentities() }
        return failure
    }
}

extension Result {
    var failure: Failure? {
        if case .failure(let failure) = self { failure } else { nil }
    }
}
