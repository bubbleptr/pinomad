import Darwin
import Foundation

/// One way this device can reach a paired machine (#502): one of the ordered
/// candidates a connection round dials (ADR-0032), described for
/// Settings → Hosts. Mirrors the Web's `host-routes.ts`.
public struct HostRoute: Equatable, Sendable {
    public let url: String
    /// Which network or server carries it: "Account relay", "Tailnet", "LAN"…
    public let label: String
    /// `host[:port]`, without the scheme or path.
    public let address: String
    /// False when the host's connection mode leaves this route out.
    public let isOn: Bool
}

private enum CandidateRole { case loopback, relay, direct, legacy }

/// The Auto order (`candidatePlan` in `remote-candidates.ts`): a loopback
/// legacy url, then the host's relays, then its directs, each url once. A
/// stored set owns the remote candidates, even an empty one; without one the
/// legacy url is the only remote candidate.
private func candidatePlan(_ host: HostRecord) -> [(url: String, role: CandidateRole)] {
    var candidates: [(url: String, role: CandidateRole)] = []
    var seen = Set<String>()
    func add(_ url: String, _ role: CandidateRole) {
        guard seen.insert(url).inserted else { return }
        candidates.append((url, role))
    }
    let legacyIsLoopback = hostnameOf(host.url).map(isLoopbackHostname) ?? false
    if legacyIsLoopback { add(host.url, .loopback) }
    if let set = host.endpointSet {
        for endpoint in set.endpoints where endpoint.role == .relay { add(endpoint.url, .relay) }
        for endpoint in set.endpoints where endpoint.role == .direct { add(endpoint.url, .direct) }
    } else if !legacyIsLoopback {
        add(host.url, .legacy)
    }
    return candidates
}

/// `filterCandidatesForMode`: Relay only keeps loopback, relay and legacy;
/// Direct only keeps loopback and direct.
private func isAllowed(_ role: CandidateRole, in mode: HostConnectionMode) -> Bool {
    switch mode {
    case .auto: true
    case .relayOnly: role != .direct
    case .directOnly: role == .loopback || role == .direct
    }
}

public func hostRoutes(_ host: HostRecord) -> [HostRoute] {
    let accountHostname = host.account.flatMap { hostnameOf($0.serverOrigin) }
    let mode = host.connectionMode ?? .auto
    return candidatePlan(host).map { candidate in
        HostRoute(
            url: candidate.url,
            label: label(candidate.url, candidate.role, accountHostname: accountHostname),
            address: addressOf(candidate.url),
            isOn: isAllowed(candidate.role, in: mode))
    }
}

private func label(_ url: String, _ role: CandidateRole, accountHostname: String?) -> String {
    let isAccountServer = accountHostname != nil && hostnameOf(url) == accountHostname
    switch role {
    case .relay: return isAccountServer ? "Account relay" : "Relay"
    case .loopback: return RtcDiagnosticsText.scopeLabel(.loopback)
    // A legacy url carries no role: the account's server is still its relay.
    case .legacy where isAccountServer: return "Account relay"
    case .legacy, .direct:
        let scope = scopeOf(url)
        return scope == .unknown ? "Direct" : RtcDiagnosticsText.scopeLabel(scope)
    }
}

/// The lowercased hostname without IPv6 brackets.
private func hostnameOf(_ url: String) -> String? {
    guard let host = URLComponents(string: url)?.host, !host.isEmpty else { return nil }
    return host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
}

/// `host[:port]` as the Web's `URL.host` prints it: IPv6 in brackets, the
/// scheme's default port left out.
private func addressOf(_ url: String) -> String {
    guard let components = URLComponents(string: url), let hostname = hostnameOf(url) else { return url }
    let host = hostname.contains(":") ? "[\(hostname)]" : hostname
    let defaultPort: Int? = switch components.scheme?.lowercased() {
    case "ws", "http": 80
    case "wss", "https": 443
    default: nil
    }
    guard let port = components.port, port != defaultPort else { return host }
    return "\(host):\(port)"
}

/// `isLoopbackHostname` in `endpoints.ts`.
func isLoopbackHostname(_ hostname: String) -> Bool {
    var host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host.hasSuffix(".") { host.removeLast() }
    if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return true }
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 4 && parts[0] == "127"
        && parts.dropFirst().allSatisfy { (1...3).contains($0.count) && $0.allSatisfy(\.isASCIIDigit) }
}

/// An endpoint the host published is named by the host's own config, so a
/// MagicDNS or mDNS name is trusted here (RTC candidates are not).
private func scopeOf(_ url: String) -> RtcAddressScope {
    guard let hostname = hostnameOf(url) else { return .unknown }
    if let scope = ipScope(hostname) { return scope }
    if hostname.hasSuffix(".ts.net") { return .tailnet }
    if hostname.hasSuffix(".local") { return .lan }
    return .unknown
}

/// `rtcAddressScope` in `rtc.ts`, for an IP literal; nil for a name.
func ipScope(_ hostname: String) -> RtcAddressScope? {
    var host = hostname
    if let zone = host.firstIndex(of: "%") { host = String(host[..<zone]) }
    var v4 = in_addr()
    if inet_pton(AF_INET, host, &v4) == 1 {
        return ipv4Scope(withUnsafeBytes(of: &v4) { Array($0) })
    }
    var v6 = in6_addr()
    guard inet_pton(AF_INET6, host, &v6) == 1 else { return nil }
    let bytes = withUnsafeBytes(of: &v6) { Array($0) }
    if bytes[0..<10].allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
        return ipv4Scope(Array(bytes[12..<16]))
    }
    return ipv6Scope(bytes)
}

private func ipv4Scope(_ octets: [UInt8]) -> RtcAddressScope {
    let (a, b) = (octets[0], octets[1])
    if a == 127 { return .loopback }
    if a == 100 && (64...127).contains(b) { return .tailnet }
    if a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254) {
        return .lan
    }
    return .public
}

private func ipv6Scope(_ bytes: [UInt8]) -> RtcAddressScope {
    if bytes.prefix(6).elementsEqual([0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]) { return .tailnet }
    if bytes[0] & 0xfe == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80) { return .lan }
    if bytes[0..<15].allSatisfy({ $0 == 0 }) && bytes[15] == 1 { return .loopback }
    return .public
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
