import Foundation
import Testing
@testable import PinomadCore

@Suite struct StoredHostsTests {
    private let hosts = StoredHosts(
        hosts: [record("a"), record("b"), record("c")],
        activeHostKey: "b")

    /// Forgetting the active host hands the launch slot to the first one
    /// left; forgetting another one keeps the reader where they are.
    @Test func forgettingMovesActiveOnlyWhenItWasTheActiveOne() {
        let other = hosts.forgetting("c")
        #expect(other.hosts.map(\.hostKey) == ["a", "b"])
        #expect(other.active?.hostKey == "b")

        let active = hosts.forgetting("b")
        #expect(active.hosts.map(\.hostKey) == ["a", "c"])
        #expect(active.activeHostKey == nil)
        #expect(active.active?.hostKey == "a")

        #expect(StoredHosts(hosts: [record("a")], activeHostKey: "a").forgetting("a").active == nil)
    }

    /// Only a stored host can become active — a stale key (forgotten from
    /// another screen meanwhile) leaves the choice alone.
    @Test func activatingNeedsAStoredHost() {
        #expect(hosts.activating("c").active?.hostKey == "c")
        #expect(hosts.activating("gone").active?.hostKey == "b")
    }

    /// Records written before 5.12 have no `name` (nor `account`); an app
    /// update must read them, not call the keychain corrupt.
    @Test func recordsSavedBeforeNamesStillDecode() throws {
        let data = Data("""
        {"hosts":[
          {"url":"ws://a:1/","hostKey":"a","privateKey":"k","pairedAt":0}
        ]}
        """.utf8)
        let stored = try JSONDecoder().decode(StoredHosts.self, from: data)
        #expect(stored.hosts.map(\.hostKey) == ["a"])
        #expect(stored.hosts[0].name == nil)
        #expect(stored.activeHostKey == nil)
    }

    /// A name announcement is display metadata: only that entry's `name`
    /// changes, and order plus the launch choice stay put.
    @Test func settingANameChangesOnlyThatEntry() throws {
        var stored = hosts
        stored.hosts[0].name = "Old"
        let renamed = try #require(stored.settingName("Desk", for: "a"))
        #expect(renamed.hosts.map(\.hostKey) == ["a", "b", "c"])
        #expect(renamed.hosts.map(\.name) == ["Desk", nil, nil])
        #expect(renamed.activeHostKey == "b")
        // Nothing to write when the announced name is already cached.
        #expect(renamed.settingName("Desk", for: "a") == nil)
    }

    /// The entry can be forgotten between the announcement and the write —
    /// a stale announcement must not bring it back.
    @Test func settingANameDoesNotResurrectAForgottenHost() {
        #expect(hosts.forgetting("a").settingName("Desk", for: "a") == nil)
        #expect(hosts.settingName("Desk", for: "never-paired") == nil)
    }

    /// Older hosts announce no name (or the stream hasn't landed); the
    /// cached one survives.
    @Test func aMissingAnnouncementLeavesTheCacheAlone() throws {
        var cached = record("a")
        cached.name = "Desk"
        let stored = StoredHosts(hosts: [cached])
        #expect(stored.settingName(nil, for: "a") == nil)
        #expect(stored.hosts[0].name == "Desk")
        #expect(stored.settingName("", for: "a") == nil)
        #expect(stored.hosts[0].name == "Desk")
    }

    @Test func theFFIRecordCarriesTheCachedName() {
        var named = record("a")
        named.name = "Desk"
        #expect(named.ffi.name == "Desk")
        #expect(record("a").ffi.name == nil)
    }

    /// A broken optional endpoint set costs that field only: the device key,
    /// the host entry, and every other host stay in the keychain payload.
    @Test func oneMalformedEndpointSetDoesNotLoseTheKeychain() throws {
        let data = Data("""
        {"hosts":[
          {"url":"ws://a:1/","hostKey":"a","privateKey":"ka","pairedAt":0,
           "endpointSet":{"schemaVersion":1,"endpoints":"junk"}},
          {"url":"ws://b:1/","hostKey":"b","privateKey":"kb","pairedAt":0,
           "endpointSet":{"schemaVersion":1,"endpoints":[
             {"role":"relay","url":"wss://relay.example/"},
             {"role":"direct","url":"wss://direct.example/"}]}}
        ],"activeHostKey":"b"}
        """.utf8)
        let stored = try JSONDecoder().decode(StoredHosts.self, from: data)
        #expect(stored.hosts.map(\.hostKey) == ["a", "b"])
        #expect(stored.hosts.map(\.privateKey) == ["ka", "kb"])
        #expect(stored.hosts[0].endpointSet == nil)
        #expect(stored.hosts[1].endpointSet?.endpoints.count == 2)
        #expect(stored.active?.hostKey == "b")
    }

    /// Unknown schema versions and unknown roles are ignored at the field
    /// boundary, not treated as corrupt keychain data.
    @Test func futureEndpointShapesDropOnlyTheField() throws {
        for endpoint in [
            #""endpointSet":{"schemaVersion":2,"endpoints":[]}"#,
            #""endpointSet":{"schemaVersion":1,"endpoints":[{"role":"mesh","url":"ws://x/"}]}"#,
        ] {
            let data = Data("""
            {"hosts":[{"url":"ws://a:1/","hostKey":"a","privateKey":"k","pairedAt":0,\(endpoint)}]}
            """.utf8)
            let stored = try JSONDecoder().decode(StoredHosts.self, from: data)
            #expect(stored.hosts.count == 1)
            #expect(stored.hosts[0].hostKey == "a")
            #expect(stored.hosts[0].endpointSet == nil)
        }
    }

    /// Endpoint learning updates only endpoint fields and the legacy URL,
    /// never identity, name, account or pairing time.
    @Test func settingEndpointsKeepsIdentityAndName() throws {
        var stored = StoredHosts(hosts: [record("a")], activeHostKey: "a")
        stored.hosts[0].name = "Desk"
        stored.hosts[0].account = AccountLink(serverOrigin: "https://relay", hostId: "id")
        let before = stored.hosts[0]
        let set = StoredEndpointSet(endpoints: [
            StoredEndpoint(role: .relay, url: "wss://new-relay/"),
            StoredEndpoint(role: .direct, url: "wss://new-direct/"),
        ])
        let updated = try #require(stored.settingEndpoints(set, url: "wss://new-relay/", for: "a"))
        #expect(updated.hosts[0].hostKey == before.hostKey)
        #expect(updated.hosts[0].privateKey == before.privateKey)
        #expect(updated.hosts[0].name == "Desk")
        #expect(updated.hosts[0].account == before.account)
        #expect(updated.hosts[0].pairedAt == before.pairedAt)
        #expect(updated.hosts[0].url == "wss://new-relay/")
        #expect(updated.hosts[0].endpointSet == set)
    }

    /// A late hello cannot bring a forgotten host back.
    @Test func endpointUpdateDoesNotResurrectAForgottenHost() {
        let set = StoredEndpointSet(endpoints: [StoredEndpoint(role: .relay, url: "wss://new/")])
        #expect(hosts.forgetting("a").settingEndpoints(set, url: "wss://new/", for: "a") == nil)
        #expect(hosts.settingEndpoints(set, url: "wss://new/", for: "never-paired") == nil)
    }

    @Test func endpointSetRoundTripsThroughTheFFIRecord() {
        let set = StoredEndpointSet(endpoints: [
            StoredEndpoint(role: .relay, url: "wss://relay.example/"),
            StoredEndpoint(role: .direct, url: "wss://direct.example/"),
        ])
        var host = record("a")
        host.endpointSet = set
        #expect(host.ffi.endpointSet?.endpoints.count == 2)
        #expect(StoredEndpointSet(host.ffi.endpointSet!) == set)
    }
}

private func record(_ key: String) -> HostRecord {
    HostRecord(url: "ws://\(key):1/", hostKey: key, privateKey: "k")
}
