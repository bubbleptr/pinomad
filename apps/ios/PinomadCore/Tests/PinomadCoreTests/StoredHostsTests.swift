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
}

private func record(_ key: String) -> HostRecord {
    HostRecord(url: "ws://\(key):1/", hostKey: key, privateKey: "k")
}
