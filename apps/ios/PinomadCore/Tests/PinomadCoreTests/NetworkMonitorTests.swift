import Testing
@testable import PinomadCore

/// The monitor's decision rule: report a path change when reachability or
/// the concrete addresses move, and stay quiet for repeated callbacks that
/// describe the same path.
@Suite struct NetworkChangeDetectorTests {
    private func wifi(_ address: String) -> NetworkAddress {
        NetworkAddress(interface: "en0", address: address, isIPv6: false)
    }

    private func cellular(_ address: String) -> NetworkAddress {
        NetworkAddress(interface: "pdp_ip0", address: address, isIPv6: false)
    }

    private func signature(
        _ status: NetworkPathSignature.Status,
        _ addresses: [NetworkAddress]
    ) -> NetworkPathSignature {
        NetworkPathSignature(status: status, addresses: addresses)
    }

    @Test func aRepeatedSignatureIsNotReported() {
        var detector = NetworkChangeDetector()
        let path = signature(.satisfied, [wifi("192.168.0.5")])
        let first = detector.shouldReport(path)
        let second = detector.shouldReport(path)
        #expect(first)
        #expect(!second)
    }

    @Test func aStatusFlipIsReported() {
        var detector = NetworkChangeDetector()
        let on = detector.shouldReport(signature(.satisfied, [wifi("192.168.0.5")]))
        let off = detector.shouldReport(signature(.unsatisfied, []))
        let back = detector.shouldReport(signature(.satisfied, [wifi("192.168.0.5")]))
        #expect(on)
        #expect(off)
        #expect(back)
    }

    /// Wi-Fi → cellular keeps `.satisfied`; the interface and address are
    /// what make it a real change.
    @Test func switchingFromWifiToCellularIsReported() {
        var detector = NetworkChangeDetector()
        let wifiPath = detector.shouldReport(signature(.satisfied, [wifi("192.168.0.5")]))
        let cellPath = detector.shouldReport(signature(.satisfied, [cellular("10.20.30.40")]))
        #expect(wifiPath)
        #expect(cellPath)
    }

    /// A different Wi-Fi network has the same status and interface type; the
    /// new address is the only evidence, and it still counts.
    @Test func aDifferentWifiNetworkIsReported() {
        var detector = NetworkChangeDetector()
        let first = detector.shouldReport(signature(.satisfied, [wifi("192.168.0.5")]))
        let moved = detector.shouldReport(signature(.satisfied, [wifi("192.168.1.9")]))
        #expect(first)
        #expect(moved)
    }

    @Test func anAddressOrderChangeAloneIsNotReported() {
        var detector = NetworkChangeDetector()
        let a = wifi("192.168.0.5")
        let b = NetworkAddress(interface: "en0", address: "2001:db8::5", isIPv6: true)
        let first = detector.shouldReport(signature(.satisfied, [a, b]))
        let reordered = detector.shouldReport(signature(.satisfied, [b, a]))
        #expect(first)
        #expect(!reordered)
    }
}
