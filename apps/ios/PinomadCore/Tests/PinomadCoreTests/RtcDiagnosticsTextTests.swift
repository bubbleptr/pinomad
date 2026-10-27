import Testing
@testable import PinomadCore

/// The diagnostics-to-copy mapping shared by the Path row, the address
/// disclosure, and the Last failure row (issue #385).
@Suite("RTC diagnostics text")
struct RtcDiagnosticsTextTests {
    @Test func routePrefersTheHostEnd() {
        #expect(RtcDiagnosticsText.routeScope(remote: .tailnet, local: .lan) == .tailnet)
        #expect(RtcDiagnosticsText.routeScope(remote: .lan, local: .unknown) == .lan)
        #expect(RtcDiagnosticsText.routeScope(remote: .unknown, local: .tailnet) == .tailnet)
        #expect(RtcDiagnosticsText.routeScope(remote: .unknown, local: .unknown) == nil)
    }

    @Test func pathLabelAppendsTheRouteOnlyForP2P() {
        #expect(RtcDiagnosticsText.pathLabel(path: "p2p", remote: .lan, local: .unknown) == "P2P · LAN")
        #expect(RtcDiagnosticsText.pathLabel(path: "p2p", remote: .unknown, local: .unknown) == "P2P")
        #expect(RtcDiagnosticsText.pathLabel(path: "relay", remote: nil, local: nil) == "Relay")
        #expect(RtcDiagnosticsText.pathLabel(path: "direct", remote: nil, local: nil) == "Direct")
        #expect(RtcDiagnosticsText.pathLabel(path: "loopback", remote: nil, local: nil) == "Local")
    }

    @Test func agoLabelSwitchesAtWholeMinutesAndHours() {
        #expect(RtcDiagnosticsText.agoLabel(0) == "0s ago")
        #expect(RtcDiagnosticsText.agoLabel(59_999) == "59s ago")
        #expect(RtcDiagnosticsText.agoLabel(60_000) == "1m ago")
        #expect(RtcDiagnosticsText.agoLabel(3_599_999) == "59m ago")
        #expect(RtcDiagnosticsText.agoLabel(3_600_000) == "1h ago")
    }

    @Test func candidateLabelDropsMissingParts() {
        #expect(
            RtcDiagnosticsText.candidateLabel(
                type: "host", address: "10.0.0.2:5000", scope: .lan)
                == "host · 10.0.0.2:5000 (LAN)")
        #expect(RtcDiagnosticsText.candidateLabel(type: nil, address: nil, scope: .unknown) == "Unknown")
        #expect(RtcDiagnosticsText.candidateLabel(type: "srflx", address: nil, scope: .public) == "srflx (Internet)")
    }

    @Test func failureAgeAdvancesWithLocalElapsed() {
        #expect(RtcDiagnosticsText.ageLabel(agoMs: 4_000, elapsedMs: 0) == "4s ago")
        #expect(RtcDiagnosticsText.ageLabel(agoMs: 4_000, elapsedMs: 7_000) == "11s ago")
        #expect(RtcDiagnosticsText.ageLabel(agoMs: 55_000, elapsedMs: 10_000) == "1m ago")
        #expect(
            RtcDiagnosticsText.failureMeta(
                agoMs: 4_000, elapsedMs: 7_000, remote: .lan, local: .unknown)
                == "11s ago · on LAN")
    }

    @Test func failureMetaAddsTheRouteOnlyWhenKnown() {
        #expect(
            RtcDiagnosticsText.failureMeta(
                agoMs: 12_000, elapsedMs: 0, remote: .tailnet, local: .lan)
                == "12s ago · on Tailnet")
        #expect(
            RtcDiagnosticsText.failureMeta(agoMs: 60_000, elapsedMs: 0, remote: nil, local: nil)
                == "1m ago")
        #expect(
            RtcDiagnosticsText.failureMeta(
                agoMs: 3_600_000, elapsedMs: 0, remote: .unknown, local: .public)
                == "1h ago · on Internet")
    }
}
