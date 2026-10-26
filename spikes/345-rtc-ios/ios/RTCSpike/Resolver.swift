import Foundation

enum NetworkResolver {
    struct LocalAddress {
        let interface: String
        let address: String
    }

    /// Enumerates active unicast interface addresses. The spike binds one
    /// address so every datagram has a predictable source; production code
    /// will need to rebind on path changes.
    static func localAddresses() -> [LocalAddress] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var result: [LocalAddress] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            let name = String(cString: entry.pointee.ifa_name)
            guard let raw = entry.pointee.ifa_addr else { continue }
            let family = Int32(raw.pointee.sa_family)
            guard family == AF_INET || family == AF_INET6 else { continue }
            let flags = entry.pointee.ifa_flags
            guard (flags & UInt32(IFF_UP)) != 0, (flags & UInt32(IFF_RUNNING)) != 0 else { continue }
            guard !isExcluded(interface: name, family: family) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let length = socklen_t(raw.pointee.sa_len)
            let status = getnameinfo(
                raw, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            guard status == 0 else { continue }
            let address = String(cString: host)
            guard isUsable(address: address, family: family) else { continue }
            result.append(LocalAddress(interface: name, address: address))
        }
        return result
    }

    static func isExcluded(interface name: String, family: Int32) -> Bool {
        if name.hasPrefix("lo") || name.hasPrefix("gif") || name.hasPrefix("stf") { return true }
        if name.hasPrefix("utun") || name.hasPrefix("ipsec") { return true }
        if name.hasPrefix("awdl") || name.hasPrefix("llw") { return true }
        if name.hasPrefix("bridge") || name.hasPrefix("ap") { return true }
        if name.hasPrefix("anpi") { return true }
        return false
    }

    static func isUsable(address: String, family: Int32) -> Bool {
        if family == AF_INET {
            if address.hasPrefix("127.") || address.hasPrefix("169.254.") { return false }
        } else {
            if address == "::1" || address.lowercased().hasPrefix("fe80:") { return false }
            if address.lowercased().hasPrefix("fd") || address.lowercased().hasPrefix("fc") { return false }
        }
        return true
    }

    static func primary(family: String) -> LocalAddress? {
        let all = localAddresses()
        let wantsV6 = family == "ipv6"
        let candidates = all.filter { entry in
            if wantsV6 { return entry.address.contains(":") }
            return !entry.address.contains(":")
        }
        let preferred = candidates.first { $0.interface == "en0" }
            ?? candidates.first { $0.interface == "pdp_ip0" }
            ?? candidates.first
        return preferred
    }

    static func resolveSTUN(host: String, port: UInt16, wantIPv6: Bool) -> [String] {
        var hints = addrinfo(
            ai_flags: AI_ADDRCONFIG,
            ai_family: wantIPv6 ? AF_INET6 : AF_INET,
            ai_socktype: SOCK_DGRAM,
            ai_protocol: IPPROTO_UDP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil)
        var info: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, String(port), &hints, &info)
        guard status == 0, var cursor = info else { return [] }
        defer { freeaddrinfo(info) }
        var addresses: [String] = []
        while true {
            let entry = cursor.pointee
            if let addr = entry.ai_addr {
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(addr, entry.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                    let ip = String(cString: buffer)
                    let rendered = ip.contains(":") ? "[\(ip)]:\(port)" : "\(ip):\(port)"
                    if !addresses.contains(rendered) { addresses.append(rendered) }
                }
            }
            guard let next = entry.ai_next else { break }
            cursor = next
        }
        return addresses
    }

    /// The local DNS resolver on the test Mac rewrites public names into the
    /// 198.18.0.0/15 benchmark range, where no STUN server answers. Keep the
    /// hostname as the configuration value and fall back to Cloudflare's
    /// published anycast addresses only for that detectable rewrite.
    static func stunAddresses(host: String, port: UInt16, wantIPv6: Bool, override: String?) -> [String] {
        if let override, !override.isEmpty { return [override] }
        var addresses = resolveSTUN(host: host, port: port, wantIPv6: wantIPv6)
        let poisoned = addresses.contains { $0.hasPrefix("198.18.") || $0.hasPrefix("198.19.") }
        if poisoned || addresses.isEmpty {
            let fallback = wantIPv6 ? "[2606:4700:49::]:\(port)" : "162.159.207.0:\(port)"
            addresses = [fallback]
        }
        return addresses
    }
}
