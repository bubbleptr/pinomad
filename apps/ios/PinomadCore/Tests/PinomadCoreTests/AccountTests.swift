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

    /// Automatic registration follows the shared eligibility rule: an
    /// unpaired host qualifies only when it is not declined and the local
    /// list was actually read (ADR-0035 §5).
    @Test func autoRegistrationEligibilityCarriesTheRealInputs() {
        let host = accountHost("host1", key: "key1", pairing: .available)
        let eligible = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [host],
            stored: StoredHosts(),
            rejectedHostKeys: [],
            declined: [],
            storedRead: true)
        #expect(eligible.autoRegisterHostIds == ["host1"])

        let declined = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com/",
            hosts: [host],
            stored: StoredHosts(),
            rejectedHostKeys: [],
            declined: [AccountHostRef(serverOrigin: "https://relay.example.com", hostId: "host1")],
            storedRead: true)
        #expect(declined.autoRegisterHostIds.isEmpty)

        let unread = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [host],
            stored: StoredHosts(),
            rejectedHostKeys: [],
            declined: [],
            storedRead: false)
        #expect(unread.autoRegisterHostIds.isEmpty)
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

    /// Re-pairing under a changed key stores a fresh record and leaves the
    /// old one alone — forgetting is the reader's action. Matching prefers
    /// the key that still matches.
    @Test func rePairKeepsTheOldRecordForTheUserToForget() {
        let link = AccountLink(serverOrigin: "https://relay.example.com", hostId: "host1")
        let stale = record("old", account: link)
        let fresh = record("new", account: link)
        let stored = StoredHosts(hosts: [stale, fresh], activeHostKey: "new")
        let result = AccountHosts.reconcile(
            serverOrigin: "https://relay.example.com",
            hosts: [accountHost("host1", key: "new", pairing: .available)],
            stored: stored,
            rejectedHostKeys: [])
        #expect(result.rows[0].status == .paired)
        #expect(result.rows[0].storedHostKey == "new")
        #expect(result.stored == stored)
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
            .paired(host: StoredHost(
                url: "wss://relay.example.com/c/host1", hostKey: "key1", privateKey: "private"))
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

    /// A mistyped current password is a 403, not a 401: it must not end the
    /// session it was typed into (#450).
    @Test func wrongCurrentPasswordKeepsTheSession() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 403, body: Data(#"{"error":"wrong_password"}"#.utf8)))
        let api = AccountAPI(origin: "https://relay.example.com", token: "tok", transport: transport)
        let result = await api.changePassword(current: "old", new: "a long new password")
        guard case .failure(let failure) = result else {
            Issue.record("expected wrong_password, got \(result)")
            return
        }
        #expect(failure == AccountFailure(code: "wrong_password", status: 403))
        #expect(!failure.clearsSession)
        #expect(AccountCopy.message(failure) == "The current password is wrong.")
        #expect(transport.requests[0].url == "https://relay.example.com/api/password")
    }

    // MARK: - Deleting the account and removing devices (#451, #452)

    @Test func deletingTheAccountSendsThePasswordAgain() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 204, body: Data()))
        let api = AccountAPI(origin: "https://relay.example.com", token: "tok", transport: transport)
        let result = await api.deleteAccount(password: "pw")
        guard case .success = result else {
            Issue.record("expected success, got \(result)")
            return
        }
        #expect(transport.requests[0].method == "POST")
        #expect(transport.requests[0].url == "https://relay.example.com/api/me/delete")
        #expect(transport.requests[0].body == #"{"password":"pw"}"#)
    }

    /// A wrong password and the admin's refusal are 403s: the session they
    /// were typed into stays, and each says why.
    @Test func refusedDeletionKeepsTheSession() async {
        let transport = StubAccountTransport()
        let api = AccountAPI(origin: "https://relay.example.com", token: "tok", transport: transport)
        for (code, copy) in [
            ("wrong_password", "The current password is wrong."),
            ("admin_account", "The server's admin account can't be deleted."),
        ] {
            transport.outcome = .response(AccountHTTPResponse(status: 403, body: Data(#"{"error":"\#(code)"}"#.utf8)))
            guard case .failure(let failure) = await api.deleteAccount(password: "pw") else {
                Issue.record("expected \(code)")
                continue
            }
            #expect(failure == AccountFailure(code: code, status: 403))
            #expect(!failure.clearsSession)
            #expect(AccountCopy.message(failure) == copy)
        }
    }

    @Test func devicesParseWithTheirStandingOnEachHost() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 200, body: Data(#"""
            [{"id":3,"name":"iPhone","createdAt":1,"lastSeenAt":5,"current":true,"hosts":[{"hostId":"h1","name":"omarchy","state":"revoking"}]},
             {"id":7,"createdAt":1,"lastSeenAt":2,"current":false,"hosts":[]},
             {"id":2,"createdAt":1,"lastSeenAt":2,"current":false,"kickedAt":4,"hosts":[]}]
            """#.utf8)))
        let api = AccountAPI(origin: "https://relay.example.com", token: "tok", transport: transport)
        guard case .success(let devices) = await api.listDevices() else {
            Issue.record("expected devices")
            return
        }
        #expect(transport.requests[0].method == "GET")
        #expect(transport.requests[0].url == "https://relay.example.com/api/devices")
        #expect(devices.map(\.id) == [3, 7, 2])
        #expect(devices[0].hosts == [AccountDeviceHost(hostId: "h1", name: "omarchy", state: .revoking)])
        #expect(devices[1].name == nil)
        // Only another device still on the account can be removed: this
        // one signs out instead, and a removed one is already gone.
        #expect(devices.map(\.removable) == [false, true, false])
    }

    @Test func removingADeviceTargetsTheServersId() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(status: 204, body: Data()))
        let api = AccountAPI(origin: "https://relay.example.com", token: "tok", transport: transport)
        guard case .success = await api.kickDevice(id: 12, password: "pw") else {
            Issue.record("expected success")
            return
        }
        #expect(transport.requests[0].url == "https://relay.example.com/api/devices/12/kick")
        #expect(transport.requests[0].body == #"{"password":"pw"}"#)

        transport.outcome = .response(AccountHTTPResponse(status: 409, body: Data(#"{"error":"current_device"}"#.utf8)))
        guard case .failure(let failure) = await api.kickDevice(id: 3, password: "pw") else {
            Issue.record("expected current_device")
            return
        }
        #expect(!failure.clearsSession)
        #expect(AccountCopy.message(failure) == "That's the device you're using. Sign out instead.")
    }

    @Test func signInClaimsThisDevice() async {
        let transport = StubAccountTransport()
        transport.outcome = .response(AccountHTTPResponse(
            status: 200, body: Data(#"{"user":{"username":"a"},"admin":true,"expiresAt":1,"token":"t"}"#.utf8)))
        let api = AccountAPI(origin: "https://relay.example.com", transport: transport)
        let result = await api.login(
            username: "a", password: "p", device: AccountDeviceClaim(id: "AAAAAAAAAAAAAAAAAAAAAA", name: "iPhone"))
        guard case .success(let value) = result else {
            Issue.record("expected a login, got \(result)")
            return
        }
        #expect(value.admin)
        #expect(transport.requests[0].body
            == #"{"username":"a","password":"p","device":{"id":"AAAAAAAAAAAAAAAAAAAAAA","name":"iPhone"}}"#)
    }

    /// A host that doesn't report devices can't be asked to revoke one, so
    /// the explanation names it; reporting hosts and older servers aren't.
    @Test func removalNamesHostsThatCantBeAsked() {
        func row(_ name: String, _ reports: Bool?) -> AccountHostRow {
            AccountHostRow(
                hostId: name, name: name, online: true, pairing: .available, status: .paired,
                action: .pair, storedHostKey: nil, deviceReports: reports)
        }
        let none = AccountCopy.removeDeviceExplanation(name: "Mac", hosts: [row("mbp", true), row("old", nil)])
        #expect(!none.contains("can't be asked"))
        let one = AccountCopy.removeDeviceExplanation(name: "Mac", hosts: [row("mbp", true), row("studio", false)])
        #expect(one.hasSuffix("studio can't be asked. If Mac joined it, revoke it on that host."))
        let two = AccountCopy.removeDeviceExplanation(
            name: "Mac", hosts: [row("a", false), row("b", false), row("c", false)])
        #expect(two.contains("a, b and c can't be asked."))
    }

    /// A record saved before the admin flag existed still decodes, as a
    /// regular account.
    @Test func recordFromBeforeTheAdminFlagDecodes() throws {
        let data = Data(#"{"serverOrigin":"https://x.example","username":"k","token":"t","expiresAt":1}"#.utf8)
        let record = try JSONDecoder().decode(AccountRecord.self, from: data)
        #expect(record.admin == nil)
        #expect(record.session != nil)
        #expect(AccountRecord(session: record.session!, admin: true).admin == true)
    }

    // MARK: - Device id

    /// Generated once, then the same id for every sign-in — across app runs
    /// too, since the next run reads it back from the store.
    @Test func deviceIdIsGeneratedOnceAndKept() {
        let store = MemoryDeviceIdStore()
        let id = AccountDeviceIdSource(store: store).id()
        #expect(id.count == 22)
        #expect(AccountDeviceIdSource.isValid(id))
        #expect(store.saves == 1)
        #expect(AccountDeviceIdSource(store: store).id() == id)
        #expect(store.saves == 1)
    }

    /// A stored value the server would refuse is replaced, not sent.
    @Test func invalidStoredDeviceIdIsReplaced() {
        let store = MemoryDeviceIdStore()
        store.value = "short"
        let id = AccountDeviceIdSource(store: store).id()
        #expect(id != "short")
        #expect(store.value == id)
        #expect(!AccountDeviceIdSource.isValid("has space in it 0123456789"))
        #expect(!AccountDeviceIdSource.isValid(String(repeating: "a", count: 65)))
        #expect(AccountDeviceIdSource.isValid(String(repeating: "a", count: 64)))
    }

    /// A keychain that fails costs only the reuse across runs: this run
    /// keeps one id.
    @Test func failingStoreStillKeepsOneIdForThisRun() {
        let store = MemoryDeviceIdStore()
        store.fails = true
        let source = AccountDeviceIdSource(store: store)
        #expect(source.id() == source.id())
    }

    @Test func insecureOriginNeverReachesTheTransport() async {
        let transport = StubAccountTransport()
        let api = AccountAPI(origin: "http://127.example.com", token: "tok", transport: transport)
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
        #expect(AccountCopy.message(AccountFailure.network) == "Can't reach the server. Check the address and your connection.")
        #expect(AccountCopy.message(AccountFailure(code: "invalid_credentials")) == "Wrong username or password.")
        #expect(AccountCopy.message(AccountFailure(code: "surprise")).contains("surprise"))
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

private final class MemoryDeviceIdStore: AccountDeviceIdStore, @unchecked Sendable {
    var value: String?
    var fails = false
    var saves = 0

    func load() throws -> String? {
        if fails { throw AccountStoreError.keychain(-25300) }
        return value
    }

    func save(_ id: String) throws {
        if fails { throw AccountStoreError.keychain(-25300) }
        value = id
        saves += 1
    }
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
