import Foundation
import os
import Testing
@testable import PinomadCore

/// The account logic the UI only assembles: session lifetime, host-row
/// verdicts, link adoption, and the HTTP seam around the core's request and
/// response builders.
@Suite("Account")
struct AccountTests {
    // MARK: - Session lifetime

    /// Only the server saying the session is gone clears the stored token.
    /// A wrong password or a dead network must leave it alone — the next
    /// request may still work.
    @Test func onlyUnauthenticatedClearsTheSession() {
        #expect(AccountFailure(code: "unauthenticated").clearsSession)
        #expect(!AccountFailure(code: "invalid_credentials").clearsSession)
        #expect(!AccountFailure(code: "rate_limited").clearsSession)
        #expect(!AccountFailure.network.clearsSession)
        #expect(!AccountFailure(code: "host_offline", status: 409).clearsSession)
    }

    /// Signing out (or expiring) drops the token but leaves what the login
    /// form needs to prefill.
    @Test func signedOutRecordKeepsOriginAndUsername() {
        let session = AccountSession(
            serverOrigin: "https://relay.example.com",
            username: "kieran",
            token: "secret",
            expiresAt: 1_000)
        let record = AccountRecord(session: session).clearingToken()
        #expect(record.session == nil)
        #expect(record.serverOrigin == "https://relay.example.com")
        #expect(record.username == "kieran")
        #expect(record.token == nil)
    }

    @Test func expiredSessionIsNotLive() {
        let session = AccountSession(
            serverOrigin: "https://relay.example.com",
            username: "kieran",
            token: "secret",
            expiresAt: 1_000)
        #expect(session.isExpired(at: Date(timeIntervalSince1970: 2)))
        #expect(!session.isExpired(at: Date(timeIntervalSince1970: 0.5)))
    }

    // MARK: - Host rows

    /// A stored pairing whose Noise key matches is paired and connects to
    /// that stored host.
    @Test func matchingKeyIsPairedAndConnects() {
        let stored = StoredHosts(hosts: [
            record("key1", account: AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1"))
        ], activeHostKey: "key1")
        let result = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com/",
            hosts: [accountHost("host1", key: "key1", pairing: .available)],
            stored: stored,
            rejectedHostKeys: [])
        #expect(result.rows.count == 1)
        #expect(result.rows[0].status == .paired)
        #expect(result.rows[0].action == .connect(hostKey: "key1"))
        #expect(result.rows[0].storedHostKey == "key1")
        #expect(!result.changed)
    }

    /// A pairing saved before account links existed adopts the link, once.
    @Test func preAccountPairingAdoptsTheLink() {
        let stored = StoredHosts(hosts: [record("key1")], activeHostKey: "key1")
        let result = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com/",
            hosts: [accountHost("host1", key: "key1", pairing: .available)],
            stored: stored,
            rejectedHostKeys: [])
        #expect(result.rows[0].status == .paired)
        #expect(result.changed)
        #expect(result.stored.hosts[0].account == AccountLink(
            serverOrigin: "https://relay.example.com", hostId: "host1"))

        // Reconciling again is a no-op — the link is already there.
        let again = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [accountHost("host1", key: "key1", pairing: .available)],
            stored: result.stored,
            rejectedHostKeys: [])
        #expect(!again.changed)
    }

    /// The server's pairing verdict decides whether the Pair button works,
    /// and each non-available verdict carries a reason.
    @Test func unpairedHostUsesTheServerVerdict() {
        let available = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [accountHost("host1", key: "key1", pairing: .available)],
            stored: StoredHosts(),
            rejectedHostKeys: []).rows[0]
        #expect(available.status == .unpaired)
        #expect(available.action == .pair)
        #expect(available.pairable)
        #expect(available.pairingReason == nil)

        for pairing in [AccountHostPairing.offline, .hostTooOld, .keyMismatch] {
            let row = AccountHosts.reconcile(
                serverOrigin: "https://relay.example.com",
                hosts: [accountHost("host1", key: "key1", pairing: pairing)],
                stored: StoredHosts(),
                rejectedHostKeys: []).rows[0]
            #expect(row.status == .unpaired)
            #expect(row.action == .pair)
            #expect(!row.pairable)
            #expect(row.pairingReason != nil)
        }
    }

    /// A linked host whose key changed is reported, with only an explicit
    /// re-pair action — never an automatic one.
    @Test func changedKeyIsReportedNotRepaired() {
        let stored = StoredHosts(hosts: [
            record("old", account: AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1"))
        ])
        let result = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [accountHost("host1", key: "new", pairing: .available)],
            stored: stored,
            rejectedHostKeys: [])
        #expect(result.rows[0].status == .keyChanged)
        #expect(result.rows[0].action == .rePair)
        #expect(result.rows[0].storedHostKey == "old")
        #expect(!result.changed)
    }

    /// A 4401 marker turns the row into an explicit re-pair, not anything
    /// the model does on its own.
    @Test func rejectedHostBecomesAnExplicitRepair() {
        let stored = StoredHosts(hosts: [
            record("key1", account: AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1"))
        ])
        let result = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [accountHost("host1", key: "key1", pairing: .available)],
            stored: stored,
            rejectedHostKeys: ["key1"])
        #expect(result.rows[0].status == .rejected)
        #expect(result.rows[0].action == .rePair)
    }

    /// A 4401 heard before the account was signed in (or before the entry
    /// adopted its link) still applies when the row is finally built.
    @Test func rejectionSurvivesLinkAdoption() {
        let stored = StoredHosts(hosts: [record("key1")])
        let result = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [accountHost("host1", key: "key1", pairing: .available)],
            stored: stored,
            rejectedHostKeys: ["key1"])
        #expect(result.rows[0].status == .rejected)
        #expect(result.rows[0].action == .rePair)
        #expect(result.changed)
        #expect(result.stored.hosts[0].account?.hostId == "host1")
    }

    /// After an explicit re-pair the stale linked record can never connect
    /// again; it must stop matching the account host.
    @Test func rePairPrunesTheStaleLinkedRecord() {
        let stale = record("old", account: AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1"))
        let fresh = record("new", account: AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1"))
        let other = record("other", account: AccountLink(serverOrigin: "https://other.example.com", hostId: "host1"))
        let pruned = AccountHosts.pruningStale(
            StoredHosts(hosts: [stale, fresh, other], activeHostKey: "new"),
            serverOrigin: "https://relay.example.com/",
            hostId: "host1",
            keepingHostKey: "new")
        #expect(pruned.hosts.map { $0.hostKey } == ["new", "other"])
        #expect(pruned.activeHostKey == "new")
    }

    /// A server-vouched pairing writes its account link beside the host, in
    /// the same keychain save the ordinary pairing path uses.
    @Test func accountPairingSavesTheLinkWithTheHost() async throws {
        let store = StubHostStore()
        let client = try PinomadClient.pair(
            link: testPairingLink, deviceName: "test", devicePrivateKey: nil)
        let link = AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1")
        let session = PinomadSession(
            client: client,
            dependencies: SessionDependencies(
                socketFactory: FakeSocketFactory(), clock: TestClock(), hostStore: store),
            pairingAccount: link)
        session.enqueue(.commands([
            .paired(url: "wss://relay.example.com/c/host1", hostKey: "key1", privateKey: "private")
        ]))
        await session.waitForIdle()
        #expect(store.stored.active?.account == link)
        session.close()
    }

    // MARK: - HTTP seam

    @Test func bearerRequestIsAssembledAndParsed() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(
            status: 200,
            body: Data(#"[{"hostId":"h1","name":"h1","noisePublicKey":"key","online":true,"lastSeenAt":1,"pairing":"available"}]"#.utf8)))
        let api = AccountAPI(origin: "https://relay.example.com/", token: "tok", transport: transport)
        let result = await api.listHosts()

        guard case .success(let hosts) = result else {
            Issue.record("expected hosts, got \(result)")
            return
        }
        #expect(hosts == [accountHost("h1", key: "key", pairing: .available)])
        let request = transport.requests[0]
        #expect(request.method == "GET")
        #expect(request.url == "https://relay.example.com/api/hosts")
        #expect(request.headers == [AccountHttpHeader(name: "authorization", value: "Bearer tok")])
        #expect(request.body == nil)
    }

    @Test func transportFailureBecomesNetwork() async {
        let transport = StubAccountTransport()
        transport.outcome = .error
        let api = AccountAPI(origin: "https://relay.example.com", token: "tok", transport: transport)
        let result = await api.listHosts()
        guard case .failure(let failure) = result else {
            Issue.record("expected a network failure, got \(result)")
            return
        }
        #expect(failure == AccountFailure.network)
    }

    @Test func unauthorizedAnswerCarriesTheServerCode() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 401, body: Data()))
        let api = AccountAPI(origin: "https://relay.example.com", token: "dead", transport: transport)
        let result = await api.me()
        guard case .failure(let failure) = result else {
            Issue.record("expected unauthenticated, got \(result)")
            return
        }
        #expect(failure == AccountFailure(code: "unauthenticated", status: 401))
    }

    @Test func insecureOriginNeverReachesTheTransport() async {
        let transport = StubAccountTransport()
        let api = AccountAPI(origin: "http://relay.example.com", token: "tok", transport: transport)
        let result = await api.listHosts()
        guard case .failure(let failure) = result else {
            Issue.record("expected insecure_origin, got \(result)")
            return
        }
        #expect(failure == AccountFailure(code: "insecure_origin"))
        #expect(transport.requests.isEmpty)
    }

    /// A 307 must not carry the bearer or login body to a plaintext host;
    /// the 3xx itself comes back for the core to report.
    @Test func redirectsAreNotFollowed() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedirectURLProtocol.self]
        let transport = URLSessionAccountTransport(session: URLSession(configuration: configuration))
        let response = try await transport.send(
            accountProbeRequest(origin: "https://relay.example.com"))
        #expect(response.status == 307)
        #expect(RedirectURLProtocol.requested == [URL(string: "https://relay.example.com/api/me")!])
    }

    @Test func probeReadsTheVerdicts() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 401, body: Data()))
        #expect(await AccountProbe(transport: transport).probe(origin: "https://relay.example.com") == .enabled)

        transport.outcome = .response(AccountHTTPResponse(status: 404, body: Data()))
        #expect(await AccountProbe(transport: transport).probe(origin: "https://relay.example.com") == .disabled)
    }

    /// The 5-second probe budget covers the whole exchange, body read
    /// included — a transport that never answers is unreachable.
    @Test func probeTimeoutIsUnreachable() async {
        let probe = AccountProbe(transport: HangingAccountTransport(), timeout: .milliseconds(20))
        #expect(await probe.probe(origin: "https://relay.example.com") == .unreachable)
    }

    @Test func errorCopyKeepsUnknownCodesVisible() {
        #expect(AccountCopy.message(AccountFailure.network) == "连不上服务端，检查地址和网络。")
        #expect(AccountCopy.message(AccountFailure(code: "invalid_credentials")) == "用户名或密码不对。")
        #expect(AccountCopy.message(AccountFailure(code: "surprise")).contains("surprise"))
    }

    /// "Sign out everywhere" must warn even on 401: that only proves this
    /// device's token was dead, not that the other sessions were revoked.
    /// The core accepts any "127." prefix as loopback; iOS must not let
    /// http://127.relay.example.com carry a password in cleartext.
    @Test func strictOriginOnlyAllowsRealLoopback() {
        #expect(isSecureAccountOrigin("http://127.0.0.1:7441"))
        #expect(isSecureAccountOrigin("http://127.1.2.3"))
        #expect(isSecureAccountOrigin("http://localhost:7441"))
        #expect(isSecureAccountOrigin("http://dev.localhost:7441"))
        #expect(isSecureAccountOrigin("https://relay.example.com"))
        #expect(!isSecureAccountOrigin("http://127.relay.example.com"))
        #expect(!isSecureAccountOrigin("http://127.0.0.1.evil.example"))
        #expect(!isSecureAccountOrigin("http://relay.example.com"))
        #expect(!isSecureAccountOrigin("ftp://127.0.0.1"))
    }

    @Test func signOutWarningDistinguishesScope() {
        let dead = AccountFailure(code: "unauthenticated")
        #expect(AccountCopy.signOutWarning(everywhere: false, failure: dead) == nil)
        #expect(AccountCopy.signOutWarning(everywhere: true, failure: dead) != nil)
        #expect(AccountCopy.signOutWarning(everywhere: false, failure: .network) != nil)
        #expect(AccountCopy.signOutWarning(everywhere: true, failure: nil) == nil)
    }
}

private func record(_ key: String, account: AccountLink? = nil) -> HostRecord {
    HostRecord(url: "wss://relay.example.com/c/\(key)", hostKey: key, privateKey: "private", account: account)
}

private func accountHost(
    _ id: String,
    key: String,
    pairing: AccountHostPairing
) -> AccountHost {
    AccountHost(hostId: id, name: id, noisePublicKey: key, online: true, lastSeenAt: 1, pairing: pairing)
}

private enum StubOutcome {
    case response(AccountHTTPResponse)
    case error
}

private final class StubAccountTransport: AccountTransport, @unchecked Sendable {
    private struct State {
        var outcome = StubOutcome.error
        var requests: [AccountHttpRequest] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    var outcome: StubOutcome {
        get { state.withLock { $0.outcome } }
        set { state.withLock { $0.outcome = newValue } }
    }

    var requests: [AccountHttpRequest] { state.withLock { $0.requests } }

    func send(_ request: AccountHttpRequest) async throws -> AccountHTTPResponse {
        let outcome = state.withLock { state -> StubOutcome in
            state.requests.append(request)
            return state.outcome
        }
        switch outcome {
        case .response(let response): return response
        case .error: throw URLError(.notConnectedToInternet)
        }
    }
}

/// Never answers, but honours cancellation so the probe's timeout can land.
private struct HangingAccountTransport: AccountTransport {
    func send(_ request: AccountHttpRequest) async throws -> AccountHTTPResponse {
        try await Task.sleep(for: .seconds(30))
        throw CancellationError()
    }
}

/// Answers every request with a 307 to a plaintext address, recording each
/// URL URLSession actually asks for.
private final class RedirectURLProtocol: URLProtocol, @unchecked Sendable {
    private static let state = OSAllocatedUnfairLock(initialState: [URL]())

    static var requested: [URL] { state.withLock { $0 } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: 307,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": "http://insecure.example/steal"])
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        Self.state.withLock { $0.append(url) }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
