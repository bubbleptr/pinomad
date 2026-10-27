import Darwin
import Foundation

/// One usable local address, with the interface it belongs to.
public struct NetworkAddress: Equatable, Hashable, Sendable {
    public let interface: String
    public let address: String
    public let isIPv6: Bool

    public init(interface: String, address: String, isIPv6: Bool) {
        self.interface = interface
        self.address = address
        self.isIPv6 = isIPv6
    }

    /// `[v6]:port` / `v4:port` — the form str0m and the STUN client parse.
    public func socketAddress(port: UInt16) -> String {
        isIPv6 ? "[\(address)]:\(port)" : "\(address):\(port)"
    }
}

/// The platform's own interface enumeration, shared by the RTC engine (which
/// needs a concrete source address for its host candidate) and the network
/// monitor (which uses the addresses to notice a Wi-Fi change).
public enum NetworkInterfaces {
    /// Every up, non-loopback IPv4/IPv6 address, sorted for a stable
    /// signature. Link-local IPv6 is skipped: it names an interface, not a
    /// reachable path, and changes churn on every flap.
    public static func active() -> [NetworkAddress] {
        var addresses: [NetworkAddress] = []
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
        defer { freeifaddrs(pointer) }
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(entry.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
                  let addr = entry.pointee.ifa_addr,
                  let name = entry.pointee.ifa_name else { continue }
            let family = addr.pointee.sa_family
            guard family == AF_INET || family == AF_INET6 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let length = family == AF_INET
                ? socklen_t(MemoryLayout<sockaddr_in>.size)
                : socklen_t(MemoryLayout<sockaddr_in6>.size)
            guard getnameinfo(addr, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            else { continue }
            let address = platformCString(host)
            if family == AF_INET6 && address.lowercased().hasPrefix("fe80") { continue }
            addresses.append(NetworkAddress(
                interface: platformCString(name),
                address: address,
                isIPv6: family == AF_INET6))
        }
        return addresses.sorted {
            ($0.interface, $0.address) < ($1.interface, $1.address)
        }
    }

    /// The addresses the RTC peer binds: the primary IPv4 address plus one
    /// global IPv6 address on the same interface, so a dual-stack path can
    /// try both families. IPv4 keeps the existing Wi-Fi → cellular → other
    /// preference; without IPv4 the peer is single-stack on a global IPv6.
    /// Link-local and ULA addresses never become candidates: neither is a
    /// public IPv6 path, and both churn on every flap.
    public static func rtcAddresses() -> [NetworkAddress] {
        rtcAddresses(from: active())
    }

    static func rtcAddresses(from all: [NetworkAddress]) -> [NetworkAddress] {
        let primary = primaryAddress(from: all)
        guard let primary else { return [] }
        if primary.isIPv6 { return [primary] }
        var selected = [primary]
        if let v6 = globalIPv6(on: primary.interface, in: all) {
            selected.append(v6)
        }
        return selected
    }

    /// Wi-Fi first, then cellular, then any other interface. IPv4 wins across
    /// interfaces; a global IPv6 is only the primary when no IPv4 is usable.
    private static func primaryAddress(from all: [NetworkAddress]) -> NetworkAddress? {
        if let wifi = all.first(where: { $0.interface == "en0" && !$0.isIPv6 }) { return wifi }
        if let phone = all.first(where: { $0.interface.hasPrefix("pdp_ip") && !$0.isIPv6 }) {
            return phone
        }
        if let other = all.first(where: { !$0.isIPv6 }) { return other }
        let global = all.filter { $0.isIPv6 && globalIPv6Bytes($0.address) != nil }
        if let wifi = global.first(where: { $0.interface == "en0" }) { return wifi }
        if let phone = global.first(where: { $0.interface.hasPrefix("pdp_ip") }) { return phone }
        return global.first
    }

    /// One address per interface; the numeric order keeps the choice stable
    /// while privacy addresses rotate underneath us.
    private static func globalIPv6(
        on interface: String,
        in all: [NetworkAddress]
    ) -> NetworkAddress? {
        var best: (NetworkAddress, [UInt8])?
        for address in all {
            guard address.isIPv6, address.interface == interface,
                  let bytes = globalIPv6Bytes(address.address)
            else { continue }
            if let current = best, current.1.lexicographicallyPrecedes(bytes) { continue }
            best = (address, bytes)
        }
        return best?.0
    }

    /// A global-unicast IPv6 address, as opposed to loopback, unspecified,
    /// multicast, link-local, ULA, or an IPv4-mapped address.
    private static func globalIPv6Bytes(_ address: String) -> [UInt8]? {
        var raw = in6_addr()
        guard inet_pton(AF_INET6, address, &raw) == 1 else { return nil }
        let bytes = withUnsafeBytes(of: &raw) { Array($0) }
        guard bytes.count == 16 else { return nil }
        if bytes.allSatisfy({ $0 == 0 }) { return nil }
        if bytes.dropLast().allSatisfy({ $0 == 0 }) && bytes[15] == 1 { return nil }
        if bytes[0] == 0xff { return nil }
        if bytes[0] & 0xfe == 0xfc { return nil }
        if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80 { return nil }
        if bytes[0..<10].allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
            return nil
        }
        return bytes
    }
}


/// A NUL-terminated C string buffer as a Swift string, without the
/// deprecated `String(cString:)` initializer.
func platformCString(_ buffer: [CChar]) -> String {
    String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
}

/// Same for the NUL-terminated pointers getifaddrs hands back.
func platformCString(_ pointer: UnsafePointer<CChar>) -> String {
    var length = 0
    while pointer[length] != 0 { length += 1 }
    return String(
        decoding: UnsafeBufferPointer(start: pointer, count: length)
            .map { UInt8(bitPattern: $0) },
        as: UTF8.self)
}
