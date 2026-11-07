import Foundation
import Testing
@testable import PinomadCore

/// ADR-0044 on iOS: provider sign-in, the confirmation step, and the races
/// dureview found on Web — a superseded sign-in, a late answer for a session
/// that's gone, and a grant that lapsed while the form was open.
@Suite("Sign-in")
@MainActor
struct SignInTests {
    private let origin = "https://relay.example.com"

    private func session(_ token: String, email: String? = nil) -> AccountSession {
        AccountSession(serverOrigin: origin, username: "a@b.co", token: token, expiresAt: 9e12, email: email)
    }

    private func login(_ token: String) -> LoginSuccess {
        LoginSuccess(user: AccountUser(username: "a@b.co", email: "a@b.co"), needsEmail: false, expiresAt: 9e12, token: token)
    }

    // MARK: - Superseded sign-in

    @Test func aNewerAttemptOrASignOutSupersedesAnOlderOne() {
        let gate = SignInGate()
        let first = gate.begin(active: nil)
        #expect(gate.isCurrent(first, active: nil))

        let second = gate.begin(active: nil)
        #expect(!gate.isCurrent(first, active: nil))
        #expect(gate.isCurrent(second, active: nil))

        gate.invalidate()
        #expect(!gate.isCurrent(second, active: nil))
    }

    /// A session that came up some other way while this attempt waited wins.
    @Test func anotherSessionBecomingActiveSupersedes() {
        let gate = SignInGate()
        let ticket = gate.begin(active: nil)
        #expect(!gate.isCurrent(ticket, active: session("other")))

        let over = gate.begin(active: session("old"))
        #expect(gate.isCurrent(over, active: session("old", email: "changed@b.co")))
        #expect(!gate.isCurrent(over, active: nil))
    }

    @Test func webSignInDropsAnAnswerThatArrivesAfterAnotherSignIn() async {
        let gate = SignInGate()
        var exchanged = 0
        let result = await ProviderSignIn.web(
            provider: "google", origin: origin, pkce: OAuthPKCE(verifier: String(repeating: "v", count: 43), state: "st"),
            gate: gate, active: { nil },
            authenticate: { _ in
                // A password sign-in started while the browser was up.
                _ = gate.begin(active: nil)
                return URL(string: "pinomad://auth?code=c0de&state=st")
            },
            exchange: { _, _ in
                exchanged += 1
                return .success(self.login("t"))
            })
        #expect(result == .superseded)
        #expect(exchanged == 0)
    }

    @Test func webSignInDropsASessionThatLandsAfterSignOut() async {
        let gate = SignInGate()
        let result = await ProviderSignIn.web(
            provider: "github", origin: origin, pkce: OAuthPKCE(verifier: String(repeating: "v", count: 43), state: "st"),
            gate: gate, active: { nil },
            authenticate: { _ in URL(string: "pinomad://auth?code=c0de&state=st") },
            exchange: { _, _ in
                gate.invalidate()
                return .success(self.login("t"))
            })
        #expect(result == .superseded)
    }

    @Test func webSignInTradesTheCodeWithItsVerifier() async {
        let gate = SignInGate()
        let verifier = String(repeating: "v", count: 43)
        var asked: URL?
        var traded: (String, String)?
        let result = await ProviderSignIn.web(
            provider: "google", origin: origin + "/", pkce: OAuthPKCE(verifier: verifier, state: "st"),
            gate: gate, active: { nil },
            authenticate: { url in
                asked = url
                return URL(string: "pinomad://auth?code=c0de&state=st")
            },
            exchange: { code, verifier in
                traded = (code, verifier)
                return .success(self.login("t"))
            })
        #expect(result == .signedIn(login("t")))
        #expect(traded?.0 == "c0de")
        #expect(traded?.1 == verifier)
        let components = asked.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        #expect(components?.path == "/api/oauth/google/start")
        #expect(components?.host == "relay.example.com")
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == [
            "client": "native",
            "redirect_uri": "pinomad://auth",
            "code_challenge": OAuthPKCE(verifier: verifier, state: "st").challenge,
            "state": "st",
        ])
    }

    /// A callback for another flow (or a forged one) is never traded.
    @Test func webSignInRefusesACallbackWithAnotherState() async {
        let gate = SignInGate()
        var exchanged = 0
        let result = await ProviderSignIn.web(
            provider: "google", origin: origin, pkce: OAuthPKCE(verifier: String(repeating: "v", count: 43), state: "st"),
            gate: gate, active: { nil },
            authenticate: { _ in URL(string: "pinomad://auth?code=c0de&state=other") },
            exchange: { _, _ in
                exchanged += 1
                return .success(self.login("t"))
            })
        #expect(result == .failed(AccountFailure(code: "invalid_state")))
        #expect(exchanged == 0)
    }

    @Test func webSignInReportsTheProvidersRefusal() async {
        let gate = SignInGate()
        let result = await ProviderSignIn.web(
            provider: "google", origin: origin, pkce: OAuthPKCE(verifier: String(repeating: "v", count: 43), state: "st"),
            gate: gate, active: { nil },
            authenticate: { _ in URL(string: "pinomad://auth?error=no_verified_email&state=st") },
            exchange: { _, _ in .success(self.login("t")) })
        #expect(result == .failed(AccountFailure(code: "no_verified_email")))

        let cancelled = await ProviderSignIn.web(
            provider: "google", origin: origin, gate: gate, active: { nil },
            authenticate: { _ in nil },
            exchange: { _, _ in .success(self.login("t")) })
        #expect(cancelled == .cancelled)
    }

    @Test func appleSignInIsDroppedWhenSupersededAtEitherEnd() async {
        let gate = SignInGate()
        let early = gate.begin(active: nil)
        _ = gate.begin(active: nil)
        var asked = 0
        let first = await ProviderSignIn.apple(ticket: early, gate: gate, active: { nil }) {
            asked += 1
            return .success(.signedIn(self.login("t")))
        }
        #expect(first == .superseded)
        #expect(asked == 0)

        let late = gate.begin(active: nil)
        let second = await ProviderSignIn.apple(ticket: late, gate: gate, active: { nil }) {
            gate.invalidate()
            return .success(.signedIn(self.login("t")))
        }
        #expect(second == .superseded)

        let fresh = gate.begin(active: nil)
        let none = await ProviderSignIn.apple(ticket: fresh, gate: gate, active: { nil }) {
            .success(.noAccount(pending: "pnd", email: "x@privaterelay.appleid.com"))
        }
        #expect(none == .noAccount(pending: "pnd", email: "x@privaterelay.appleid.com"))
    }

    // MARK: - Callback, PKCE and nonce

    @Test func onlyTheAuthCallbackIsTreatedAsOne() {
        #expect(NativeOAuth.isCallback(URL(string: "pinomad://auth?code=c&state=s")!))
        #expect(NativeOAuth.isCallback(URL(string: "pinomad://auth/?error=access_denied")!))
        #expect(!NativeOAuth.isCallback(URL(string: "pinomad://pair#pair=a.b&url=wss%3A%2F%2Fx")!))
        #expect(!NativeOAuth.isCallback(URL(string: "https://auth.example.com/?code=c")!))
    }

    /// RFC 7636 appendix B.
    @Test func pkceChallengeIsTheS256OfTheVerifier() {
        let pkce = OAuthPKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "s")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let random = OAuthPKCE.random()
        #expect(random.verifier.count == 43)
        #expect(random.state != OAuthPKCE.random().state)
    }

    /// Apple gets the SHA-256 hex of the raw nonce; the server gets the raw one.
    @Test func appleNonceIsHashedAsHex() {
        #expect(AppleNonce.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let raw = AppleNonce.random()
        #expect(raw.count >= 32)
        #expect(raw != AppleNonce.random())
    }

    // MARK: - Late answers

    @Test func anAnswerForASessionThatEndedIsNotApplied() async {
        var active: AccountSession? = session("a")
        var applied: [String] = []
        let answer = await AccountScope.run(active: { active }) { sent in
            // Signed out and into another account while this ran.
            active = self.session("b")
            return sent.token
        } apply: { value, _ in
            applied.append(value)
        }
        #expect(answer == "a")
        #expect(applied.isEmpty)

        _ = await AccountScope.run(active: { active }) { sent in sent.token } apply: { value, _ in applied.append(value) }
        #expect(applied == ["b"])

        active = nil
        let none = await AccountScope.run(active: { active }) { sent in sent.token } apply: { value, _ in applied.append(value) }
        #expect(none == nil)
    }

    /// A profile update keeps the same sign-in: its own answers still land.
    @Test func aProfileUpdateIsStillTheSameSession() async {
        var active: AccountSession? = session("a")
        var applied = 0
        _ = await AccountScope.run(active: { active }) { _ in
            active = active?.with(user: AccountUser(username: "n@b.co", email: "n@b.co"))
        } apply: { _, _ in
            applied += 1
        }
        #expect(applied == 1)
    }

    // MARK: - Confirmation step

    @Test func aPasswordAccountConfirmsWithThePasswordEachTime() async {
        let step = IdentityConfirmation()
        step.load(hasPassword: true)
        #expect(step.method == .password)
        #expect(!step.ready)
        step.password = "pw"
        #expect(step.ready)
        var asked = 0
        let result = await step.confirm { _ in
            asked += 1
            return .success(ReauthGrant(reauth: "g", expiresAt: 9e12))
        }
        #expect(result == .success(.password("pw")))
        #expect(asked == 0)
    }

    /// A server that can't list sign-in methods still takes the password.
    @Test func noIdentitiesMeansThePassword() {
        let step = IdentityConfirmation()
        step.load(hasPassword: nil)
        #expect(step.method == .password)
    }

    @Test func aPasswordlessAccountTradesTheCodeOnceAndReusesTheGrant() async {
        let step = IdentityConfirmation()
        step.load(hasPassword: false)
        #expect(step.method == .code)
        await step.send { .success(()) }
        #expect(step.sent)
        step.code = " 123456 "
        #expect(step.ready)
        var proofs: [ReauthProof] = []
        let now = Date(timeIntervalSince1970: 1_000)
        let reauth: (ReauthProof) async -> Result<ReauthGrant, AccountFailure> = { proof in
            proofs.append(proof)
            return .success(ReauthGrant(reauth: "g1", expiresAt: 1_000_000 + 300_000))
        }
        #expect(await step.confirm(now: now, reauth: reauth) == .success(.reauth("g1")))
        #expect(await step.confirm(now: now.addingTimeInterval(60), reauth: reauth) == .success(.reauth("g1")))
        #expect(proofs == [.code("123456")])

        // Past its five minutes the grant isn't sent again.
        _ = await step.confirm(now: now.addingTimeInterval(400), reauth: reauth)
        #expect(proofs.count == 2)
    }

    /// The server refused the grant (lapsed, or another session's): the step
    /// asks again, with Send code, and the rest of the form stays as typed.
    @Test func anExpiredGrantShowsTheStepAgain() async {
        let step = IdentityConfirmation()
        step.load(hasPassword: false)
        await step.send { .success(()) }
        step.code = "123456"
        _ = await step.confirm { _ in .success(ReauthGrant(reauth: "g1", expiresAt: 9e12)) }

        #expect(step.refused(AccountFailure(code: "invalid_reauth", status: 403)))
        #expect(step.method == .code)
        #expect(!step.sent)
        #expect(step.code.isEmpty)
        #expect(!step.ready)

        await step.send { .success(()) }
        step.code = "654321"
        var proofs: [ReauthProof] = []
        let again = await step.confirm { proof in
            proofs.append(proof)
            return .success(ReauthGrant(reauth: "g2", expiresAt: 9e12))
        }
        #expect(again == .success(.reauth("g2")))
        #expect(proofs == [.code("654321")])
    }

    @Test func otherRefusalsKeepTheConfirmation() async {
        let step = IdentityConfirmation()
        step.load(hasPassword: true)
        step.password = "pw"
        #expect(!step.refused(AccountFailure(code: "wrong_password", status: 403)))
        #expect(step.password == "pw")
        #expect(step.ready)
    }

    @Test func aFailedSendSaysWhy() async {
        let step = IdentityConfirmation()
        step.load(hasPassword: false)
        await step.send { .failure(AccountFailure(code: "no_email", status: 409)) }
        #expect(!step.sent)
        #expect(step.sendError == AccountFailure(code: "no_email", status: 409))
    }

    // MARK: - HTTP seam

    @Test func appleWithNoAccountAnswersThePendingId() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(
            status: 409,
            body: Data(#"{"error":"no_account","reason":"no_account","pending":"pnd","email":"x@privaterelay.appleid.com"}"#.utf8)))
        let api = AccountAPI(origin: origin, transport: transport)
        let result = await api.appleNative(identityToken: "id", authorizationCode: "ac", nonce: "raw", name: "Ann", device: nil)
        #expect(result == .success(.noAccount(pending: "pnd", email: "x@privaterelay.appleid.com")))
        let sent = transport.requests[0]
        #expect(sent.url == "https://relay.example.com/api/oauth/apple/native")
        #expect(sent.headers == [AccountHttpHeader(name: "content-type", value: "application/json")])
        #expect(sent.body == #"{"identityToken":"id","authorizationCode":"ac","nonce":"raw","name":"Ann"}"#)
    }

    @Test func linkingAPendingSignInSendsTheConfirmationWithTheBearer() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 204, body: Data()))
        let api = AccountAPI(origin: origin, token: "tok", transport: transport)
        let id = String(repeating: "p", count: 43)
        #expect(await api.linkPending(id: id, confirmation: .password("pw")) == .success(nil))
        let sent = transport.requests[0]
        #expect(sent.url == "https://relay.example.com/api/oauth/pending/\(id)/link")
        #expect(sent.headers.first == AccountHttpHeader(name: "authorization", value: "Bearer tok"))
        #expect(sent.body == #"{"password":"pw"}"#)
    }

    @Test func confirmedActionsTakeAGrant() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 204, body: Data()))
        let api = AccountAPI(origin: origin, token: "tok", transport: transport)
        _ = await api.deleteAccount(confirmation: .reauth("g"))
        _ = await api.changePassword(current: .reauth("g"), new: "a first password")
        _ = await api.unlinkProvider("google", confirmation: .reauth("g"))
        #expect(transport.requests.map(\.body) == [
            #"{"reauth":"g"}"#,
            #"{"reauth":"g","newPassword":"a first password"}"#,
            #"{"reauth":"g"}"#,
        ])
        #expect(transport.requests[2].url == "https://relay.example.com/api/me/identities/google/remove")
    }

    @Test func identitiesAndMethodsParse() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(
            status: 200,
            body: Data(#"{"identities":[{"provider":"google","email":"a@gmail.com","createdAt":3}],"hasPassword":false}"#.utf8)))
        let api = AccountAPI(origin: origin, token: "tok", transport: transport)
        #expect(await api.identities() == .success(AccountIdentities(
            identities: [AccountIdentity(provider: "google", email: "a@gmail.com", createdAt: 3)],
            hasPassword: false)))

        transport.outcome = .response(AccountHTTPResponse(
            status: 200, body: Data(#"{"registration":true,"email":true,"providers":["apple","google"]}"#.utf8)))
        #expect(await api.authMethods() == .success(AuthMethods(registration: true, email: true, providers: ["apple", "google"])))
    }
}
