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

    /// The address the RTC socket binds to: Wi-Fi first, then cellular, then
    /// any other interface. IPv4 is preferred because a dual-stack network
    /// still routes v4 to the common case; a v6-only interface falls back to
    /// v6 only when nothing else is up.
    public static func primary() -> NetworkAddress? {
        let all = active()
        if let wifi = all.first(where: { $0.interface == "en0" && !$0.isIPv6 }) { return wifi }
        if let phone = all.first(where: { $0.interface.hasPrefix("pdp_ip") && !$0.isIPv6 }) { return phone }
        if let other = all.first(where: { !$0.isIPv6 }) { return other }
        if let wifi6 = all.first(where: { $0.interface == "en0" }) { return wifi6 }
        return all.first
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
