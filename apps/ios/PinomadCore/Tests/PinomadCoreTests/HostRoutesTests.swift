import Foundation
import Testing
@testable import PinomadCore

/// The routes Settings → Hosts lists under each machine (#502): which network
/// each published endpoint is on and which ones the connection mode leaves
/// out. Which socket carries the connection is the status line's job: the
/// stored set can change under a live socket.
@Suite struct HostRoutesTests {
    private static let relay = StoredEndpoint(role: .relay, url: "wss://app.pinomad.si/relay/h")
    private static let tailnet = StoredEndpoint(role: .direct, url: "wss://studio.tailf76614.ts.net:7422")
    private static let lan = StoredEndpoint(role: .direct, url: "ws://192.168.1.42:7422")

    private func host(
        url: String = "wss://app.pinomad.si/relay/h",
        _ endpoints: [StoredEndpoint]? = nil,
        account: String? = nil,
        mode: HostConnectionMode? = nil
    ) -> HostRecord {
        HostRecord(
            url: url, hostKey: "k", privateKey: "p",
            account: account.map { AccountLink(serverOrigin: $0, hostId: "k") },
            endpointSet: endpoints.map { StoredEndpointSet(endpoints: $0) },
            connectionMode: mode)
    }

    private func pairs(_ routes: [HostRoute]) -> [[String]] {
        routes.map { [$0.label, $0.address] }
    }

    @Test func namesEachRouteByItsNetworkRelayFirst() {
        let routes = hostRoutes(host([Self.tailnet, Self.lan, Self.relay]))
        #expect(pairs(routes) == [
            ["Relay", "app.pinomad.si"],
            ["Tailnet", "studio.tailf76614.ts.net:7422"],
            ["LAN", "192.168.1.42:7422"],
        ])
        #expect(routes.allSatisfy { $0.isOn })
    }

    @Test func callsTheRelayOfTheAccountTheHostJoinedTheAccountRelay() {
        let routes = hostRoutes(host([Self.relay], account: "https://APP.pinomad.si"))
        #expect(routes.first?.label == "Account relay")
    }

    @Test func putsThisComputersOwnAddressFirst() {
        let routes = hostRoutes(host(url: "ws://127.0.0.1:7431", [Self.relay]))
        #expect(routes.map(\.label) == ["Local", "Relay"])
    }

    @Test func fallsBackToThePairedAddressWithoutASet() {
        #expect(pairs(hostRoutes(host(url: "wss://100.101.102.103:7422"))) == [["Tailnet", "100.101.102.103:7422"]])
        // A legacy url carries no role: the account's server is still its relay.
        let legacy = hostRoutes(host(account: "https://app.pinomad.si"))
        #expect(pairs(legacy) == [["Account relay", "app.pinomad.si"]])
        #expect(pairs(hostRoutes(host(url: "wss://example.com/h"))) == [["Direct", "example.com"]])
    }

    @Test func anEmptySetOwnsTheRemoteRoutes() {
        #expect(hostRoutes(host([])).isEmpty)
    }

    @Test func classifiesDirectAddressesByScope() {
        let routes = hostRoutes(host([
            StoredEndpoint(role: .direct, url: "wss://[fd7a:115c:a1e0::1]:7422"),
            StoredEndpoint(role: .direct, url: "ws://[fe80::1]:7422"),
            StoredEndpoint(role: .direct, url: "ws://studio.local:7422"),
            StoredEndpoint(role: .direct, url: "wss://studio.example.com"),
        ]))
        #expect(pairs(routes) == [
            ["Tailnet", "[fd7a:115c:a1e0::1]:7422"],
            ["LAN", "[fe80::1]:7422"],
            ["LAN", "studio.local:7422"],
            ["Direct", "studio.example.com"],
        ])
    }

    @Test func marksTheRoutesTheConnectionModeLeavesOut() {
        let relayOnly = hostRoutes(host([Self.relay, Self.tailnet], mode: .relayOnly))
        #expect(relayOnly.map(\.isOn) == [true, false])
        let directOnly = hostRoutes(host([Self.relay, Self.tailnet], mode: .directOnly))
        #expect(directOnly.map(\.isOn) == [false, true])
        // Loopback stays on in every mode; a legacy url counts as a relay.
        let local = hostRoutes(host(url: "ws://localhost:7431", [Self.relay], mode: .directOnly))
        #expect(local.map(\.isOn) == [true, false])
        #expect(hostRoutes(host(mode: .directOnly)).map(\.isOn) == [false])
        #expect(hostRoutes(host(mode: .relayOnly)).map(\.isOn) == [true])
    }
}
