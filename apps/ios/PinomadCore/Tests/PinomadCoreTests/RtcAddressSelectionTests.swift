import Testing
@testable import PinomadCore

/// The RTC peer needs both families when the device has them: the cellular
/// IPv4 path is often behind a symmetric CGNAT, while a global IPv6 pair can
/// still connect directly. These cover what may and may not become a socket.
@Suite struct RtcAddressSelectionTests {
    private func v4(_ interface: String, _ address: String) -> NetworkAddress {
        NetworkAddress(interface: interface, address: address, isIPv6: false)
    }

    private func v6(_ interface: String, _ address: String) -> NetworkAddress {
        NetworkAddress(interface: interface, address: address, isIPv6: true)
    }

    @Test func dualStackKeepsThePrimaryV4AndOneGlobalV6() {
        let all = [
            v6("en0", "240e:3a1:8b1::10"),
            v4("pdp_ip0", "10.20.30.40"),
            v6("en0", "240e:3a1:8b1::9"),
            v6("en0", "fd00::1"),
            v4("en0", "192.168.1.5"),
        ]
        let selected = NetworkInterfaces.rtcAddresses(from: all)
        #expect(selected.map { $0.address } == ["192.168.1.5", "240e:3a1:8b1::9"])
        #expect(selected.allSatisfy { $0.interface == "en0" })
    }

    @Test func linkLocalAndULAAddressesAreNeverSelected() {
        let all = [
            v4("en0", "192.168.1.5"),
            v6("en0", "fe80::1"),
            v6("en0", "fd00::1"),
            v6("en0", "fc00::1"),
        ]
        let selected = NetworkInterfaces.rtcAddresses(from: all)
        #expect(selected.map { $0.address } == ["192.168.1.5"])

        let unusable = all.filter { $0.isIPv6 }
        #expect(NetworkInterfaces.rtcAddresses(from: unusable).isEmpty)
    }

    @Test func v6OnlyNetworkIsSingleStack() {
        let selected = NetworkInterfaces.rtcAddresses(
            from: [v6("en0", "240e:3a1:8b1::9")])
        #expect(selected.map { $0.address } == ["240e:3a1:8b1::9"])
        #expect(selected.allSatisfy { $0.isIPv6 })
    }

    @Test func v4OnlyNetworkIsSingleStack() {
        let selected = NetworkInterfaces.rtcAddresses(
            from: [v4("en0", "192.168.1.5")])
        #expect(selected.map { $0.address } == ["192.168.1.5"])
        #expect(selected.allSatisfy { !$0.isIPv6 })
    }

    @Test func cellularKeepsBothFamiliesOnPdpInterfaces() {
        let all = [
            v6("pdp_ip0", "240e:3a1:8b1::9"),
            v4("pdp_ip0", "10.20.30.40"),
        ]
        let selected = NetworkInterfaces.rtcAddresses(from: all)
        #expect(selected.map { $0.address } == ["10.20.30.40", "240e:3a1:8b1::9"])
    }

    @Test func theGlobalV6ChoiceDoesNotDependOnInputOrder() {
        let a = v6("en0", "240e:3a1:8b1::9")
        let b = v6("en0", "240e:3a1:8b1::10")
        let primary = v4("en0", "192.168.1.5")
        let forward = NetworkInterfaces.rtcAddresses(from: [primary, a, b])
        let reversed = NetworkInterfaces.rtcAddresses(from: [b, a, primary])
        #expect(forward.map { $0.address } == reversed.map { $0.address })
        #expect(forward.last?.address == "240e:3a1:8b1::9")
    }
}
