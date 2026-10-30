import Foundation
import Testing
@testable import PinomadCore

/// The persisted declined set is the boundary that keeps a forgotten or
/// refusing host from being silently registered again (ADR-0035 §5).
@Suite("Declined account hosts")
@MainActor
struct DeclinedAccountHostsTests {
    private func defaults() -> UserDefaults {
        let suite = "DeclinedAccountHostsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func identitiesSurviveANewReader() {
        let defaults = defaults()
        let store = DeclinedAccountHosts(defaults: defaults)
        #expect(store.add(serverOrigin: "https://relay.example.com/", hostId: "h1"))
        #expect(store.contains(serverOrigin: "https://relay.example.com", hostId: "h1"))

        let reopened = DeclinedAccountHosts(defaults: defaults)
        #expect(reopened.list() == [
            AccountHostIdentity(serverOrigin: "https://relay.example.com", hostId: "h1")
        ])
        #expect(reopened.remove(serverOrigin: "https://relay.example.com/", hostId: "h1"))
        #expect(DeclinedAccountHosts(defaults: defaults).list().isEmpty)
    }

    @Test func originIsCanonicalAndDuplicatesCollapse() {
        let store = DeclinedAccountHosts(defaults: defaults())
        #expect(store.add(serverOrigin: "https://relay.example.com/", hostId: "h1"))
        #expect(!store.add(serverOrigin: "https://relay.example.com", hostId: "h1"))
        #expect(store.list().count == 1)
        #expect(!store.contains(serverOrigin: "https://other.example.com", hostId: "h1"))
    }

    @Test func aCorruptValueReadsAsEmpty() {
        let defaults = defaults()
        defaults.set("not json", forKey: DeclinedAccountHosts.defaultsKey)
        #expect(DeclinedAccountHosts(defaults: defaults).list().isEmpty)
    }
}
