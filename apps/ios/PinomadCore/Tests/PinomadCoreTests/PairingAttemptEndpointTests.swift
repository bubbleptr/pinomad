import Foundation
import Testing
@testable import PinomadCore

@Suite("Pairing attempt endpoints")
struct PairingAttemptEndpointTests {
    private func set(_ urls: [String]) -> StoredEndpointSet {
        StoredEndpointSet(endpoints: urls.map {
            StoredEndpoint(role: $0.contains("relay") ? .relay : .direct, url: $0)
        })
    }

    /// A pre-ready hello update must reach Retry, but only its routing fields
    /// may change: the device key the host accepted and the display identity
    /// stay from the pairing record.
    @Test func learnedEndpointsReachRetryWithoutReplacingIdentity() {
        let account = AccountLink(serverOrigin: "https://relay.example", hostId: "host")
        let pairedAt = Date(timeIntervalSince1970: 1_000)
        let original = HostRecord(
            url: "wss://a/",
            hostKey: "host-key",
            privateKey: "accepted-key",
            name: "Desk",
            account: account,
            endpointSet: set(["wss://a/"]),
            pairedAt: pairedAt)
        var attempt = PairingAttempt()
        attempt.connect(original)

        var patch = original
        patch.url = "wss://b/"
        patch.privateKey = "stale-keychain-key"
        patch.name = "Other"
        patch.endpointSet = set(["wss://b/"])
        attempt.endpoints(patch)

        guard case .host(let retried) = attempt.retry else {
            Issue.record("expected a stored-host retry")
            return
        }
        #expect(retried.url == "wss://b/")
        #expect(retried.privateKey == "accepted-key")
        #expect(retried.name == "Desk")
        #expect(retried.account == account)
        #expect(retried.pairedAt == pairedAt)
        #expect(retried.endpointSet == set(["wss://b/"]))
    }

    /// An explicit empty remote set survives into Retry so the stored
    /// connect path can refuse to dial the retired legacy URL.
    @Test func emptyLearnedSetReachesRetry() {
        var attempt = PairingAttempt()
        attempt.connect(HostRecord(
            url: "wss://old/",
            hostKey: "host-key",
            privateKey: "key",
            endpointSet: set(["wss://old/"])))
        var patch = attempt.host!
        patch.endpointSet = StoredEndpointSet()
        attempt.endpoints(patch)

        guard case .host(let retried) = attempt.retry else {
            Issue.record("expected a stored-host retry")
            return
        }
        #expect(retried.endpointSet?.endpoints.isEmpty == true)
        #expect(retried.url == "wss://old/")
        #expect(retried.privateKey == "key")
    }
}
