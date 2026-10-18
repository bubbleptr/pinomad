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
}

private func record(_ key: String) -> HostRecord {
    HostRecord(url: "ws://\(key):1/", hostKey: key, privateKey: "k")
}
