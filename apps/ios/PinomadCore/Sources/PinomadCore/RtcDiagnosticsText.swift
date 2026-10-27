import Foundation

/// The diagnostics-to-copy mapping shared by the Path row, the address
/// disclosure, and the Last failure row (issue #385). Kept here so the
/// rules stay testable without a live host, mirroring the Web helper.
public enum RtcDiagnosticsText {
    public static func scopeLabel(_ scope: RtcAddressScope) -> String {
        switch scope {
        case .loopback: "Local"
        case .lan: "LAN"
        case .tailnet: "Tailnet"
        case .`public`: "Internet"
        case .unknown: "Unknown"
        }
    }

    /// The host's end decides the route; this device's end only fills in
    /// when the host's scope is unknown too.
    public static func routeScope(remote: RtcAddressScope, local: RtcAddressScope) -> RtcAddressScope? {
        if remote != .unknown { return remote }
        if local != .unknown { return local }
        return nil
    }

    public static func pathLabel(
        path: String, remote: RtcAddressScope?, local: RtcAddressScope?
    ) -> String {
        switch path {
        case "p2p":
            guard let remote, let local,
                  let scope = routeScope(remote: remote, local: local)
            else { return "P2P" }
            return "P2P · \(scopeLabel(scope))"
        case "relay": return "Relay"
        case "direct": return "Direct"
        default: return "Local"
        }
    }

    /// The failure age as of now: the core's reading plus the time since the
    /// page read it. The core clock only moves on `Clock` events, so without
    /// this the age would freeze while the page polls.
    public static func ageLabel(agoMs: UInt64, elapsedMs: UInt64) -> String {
        let (total, overflow) = agoMs.addingReportingOverflow(elapsedMs)
        return agoLabel(overflow ? UInt64.max : total)
    }

    /// Whole seconds below a minute, whole minutes below an hour, then hours.
    public static func agoLabel(_ milliseconds: UInt64) -> String {
        let seconds = Int(milliseconds / 1000)
        if seconds < 60 { return "\(seconds)s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }
        return "\(minutes / 60)h ago"
    }

    /// One candidate end, dropping the parts the platform did not report.
    public static func candidateLabel(
        type: String?, address: String?, scope: RtcAddressScope
    ) -> String {
        let details = [type, address]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if details.isEmpty { return scopeLabel(scope) }
        return "\(details.joined(separator: " · ")) (\(scopeLabel(scope)))"
    }

    /// Age plus the pair's route, for the Last failure row.
    public static func failureMeta(
        agoMs: UInt64, elapsedMs: UInt64,
        remote: RtcAddressScope?, local: RtcAddressScope?
    ) -> String {
        var parts = [ageLabel(agoMs: agoMs, elapsedMs: elapsedMs)]
        if let remote, let local, let scope = routeScope(remote: remote, local: local) {
            parts.append("on \(scopeLabel(scope))")
        }
        return parts.joined(separator: " · ")
    }
}
