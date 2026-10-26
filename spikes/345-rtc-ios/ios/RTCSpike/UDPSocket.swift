import Foundation
import Darwin

/// BSD UDP socket. Network.framework's NWConnection is connection-oriented
/// and filters by peer, while ICE needs one bound port that receives STUN,
/// DTLS and SCTP from several addresses. DispatchSourceRead gives us a
/// single ordered receive path without a second thread.
final class UDPSocket {
    private(set) var localAddress: String
    private var descriptor: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue: DispatchQueue
    private let onDatagram: (Data, String) -> Void
    private let onError: (String) -> Void

    init?(
        bind address: String,
        queue: DispatchQueue,
        onDatagram: @escaping (Data, String) -> Void,
        onError: @escaping (String) -> Void
    ) {
        self.queue = queue
        self.onDatagram = onDatagram
        self.onError = onError
        self.localAddress = ""
        let family = address.contains(":") ? AF_INET6 : AF_INET
        descriptor = socket(family, SOCK_DGRAM, IPPROTO_UDP)
        guard descriptor >= 0 else {
            onError("socket() failed: \(errno)")
            return nil
        }
        var one: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let flags = fcntl(descriptor, F_GETFL, 0)
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        do {
            localAddress = try Self.bindSocket(descriptor: descriptor, address: address)
        } catch {
            onError("bind(\(address)) failed: \(error)")
            _ = Darwin.close(descriptor)
            descriptor = -1
            return nil
        }
        let src = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        source = src
        src.resume()
    }

    func send(_ bytes: Data, to destination: String) -> Bool {
        guard descriptor >= 0 else { return false }
        guard let address = try? SocketAddress(rendered: destination) else {
            onError("bad destination \(destination)")
            return false
        }
        let result: Int = bytes.withUnsafeBytes { raw in
            address.withSockAddr { pointer, length in
                Darwin.sendto(descriptor, raw.baseAddress, raw.count, 0, pointer, length)
            }
        }
        if result < 0 {
            onError("sendto \(destination) failed: errno=\(errno)")
            return false
        }
        return result == bytes.count
    }

    func close() {
        source?.cancel()
        source = nil
        let fd = descriptor
        descriptor = -1
        if fd >= 0 { _ = Darwin.close(fd) }
    }

    private func readAvailable() {
        guard descriptor >= 0 else { return }
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            var storage = sockaddr_storage()
            var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
            let count = withUnsafeMutablePointer(to: &storage) { storagePointer in
                storagePointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                    buffer.withUnsafeMutableBytes { raw in
                        Darwin.recvfrom(descriptor, raw.baseAddress, raw.count, 0, sockaddrPointer, &length)
                    }
                }
            }
            if count < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                onError("recvfrom failed: errno=\(errno)")
                return
            }
            let rendered = Self.render(&storage, length: length)
            onDatagram(Data(buffer[0..<count]), rendered)
        }
    }

    private static func bindSocket(descriptor: Int32, address: String) throws -> String {
        var storage = sockaddr_storage()
        var length: socklen_t = 0
        if address.contains(":") {
            var addr = sockaddr_in6()
            addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            addr.sin6_family = sa_family_t(AF_INET6)
            addr.sin6_port = 0
            guard inet_pton(AF_INET6, address, &addr.sin6_addr) == 1 else { throw POSIXError(.EINVAL) }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { destination in
                    destination.copyBytes(from: raw)
                }
            }
            length = socklen_t(MemoryLayout<sockaddr_in6>.size)
        } else {
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = 0
            guard inet_pton(AF_INET, address, &addr.sin_addr) == 1 else { throw POSIXError(.EINVAL) }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { destination in
                    destination.copyBytes(from: raw)
                }
            }
            length = socklen_t(MemoryLayout<sockaddr_in>.size)
        }
        let bindResult = withUnsafePointer(to: &storage) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(descriptor, sockaddrPointer, length)
            }
        }
        guard bindResult == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var bound = sockaddr_storage()
        var boundLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let nameResult = withUnsafeMutablePointer(to: &bound) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getsockname(descriptor, sockaddrPointer, &boundLength)
            }
        }
        guard nameResult == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        return render(&bound, length: boundLength)
    }

    private static func render(_ storage: inout sockaddr_storage, length: socklen_t) -> String {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        var service = [CChar](repeating: 0, count: Int(NI_MAXSERV))
        let result = withUnsafePointer(to: &storage) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getnameinfo(
                    sockaddrPointer, length,
                    &host, socklen_t(host.count), &service, socklen_t(service.count),
                    NI_NUMERICHOST | NI_NUMERICSERV)
            }
        }
        guard result == 0 else { return "unknown" }
        let ip = String(cString: host)
        let port = String(cString: service)
        return ip.contains(":") ? "[\(ip)]:\(port)" : "\(ip):\(port)"
    }
}

private struct SocketAddress {
    private var storage = sockaddr_storage()
    private var length: socklen_t = 0

    init(rendered: String) throws {
        let host: String
        let portText: String
        if rendered.hasPrefix("[") {
            guard let close = rendered.firstIndex(of: "]") else { throw POSIXError(.EINVAL) }
            host = String(rendered[rendered.index(after: rendered.startIndex)..<close])
            let after = rendered.index(after: close)
            guard after < rendered.endIndex, rendered[after] == ":" else { throw POSIXError(.EINVAL) }
            portText = String(rendered[rendered.index(after: after)...])
        } else {
            guard let colon = rendered.lastIndex(of: ":") else { throw POSIXError(.EINVAL) }
            host = String(rendered[..<colon])
            portText = String(rendered[rendered.index(after: colon)...])
        }
        guard let port = UInt16(portText) else { throw POSIXError(.EINVAL) }
        if host.contains(":") {
            var addr = sockaddr_in6()
            addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            addr.sin6_family = sa_family_t(AF_INET6)
            addr.sin6_port = port.bigEndian
            guard inet_pton(AF_INET6, host, &addr.sin6_addr) == 1 else { throw POSIXError(.EINVAL) }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: raw) }
            }
            length = socklen_t(MemoryLayout<sockaddr_in6>.size)
        } else {
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else { throw POSIXError(.EINVAL) }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: raw) }
            }
            length = socklen_t(MemoryLayout<sockaddr_in>.size)
        }
    }

    func withSockAddr<R>(_ body: (UnsafePointer<sockaddr>, socklen_t) throws -> R) rethrows -> R {
        var copy = storage
        return try withUnsafePointer(to: &copy) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                try body(sockaddrPointer, length)
            }
        }
    }
}
