import Darwin
import Foundation
import os

private let rtcLogger = Logger(subsystem: "build.kieran.pinomad", category: "rtc")

/// The platform side of the RTC coordinator (ADR-0024 §3, ADR-0033 §6):
/// Swift owns the UDP socket and the clock, the Rust engine owns STUN and
/// str0m. Every engine call happens on one serial queue, and everything the
/// engine produces goes back into the session's single event stream.
public protocol RtcPlatform: Sendable {
    /// Bind a socket, gather candidates, and start the offer. `sink` is the
    /// session's ordered queue; all later events for this Peer go there.
    func createPeer(
        peer: UInt64,
        stun: [String],
        sink: @escaping @Sendable (SessionEvent) -> Void
    )
    func acceptAnswer(peer: UInt64, sdp: String)
    func send(peer: UInt64, bytes: Data)
    func closePeer(peer: UInt64)
    /// The interface changed: retire every Peer (the old socket's candidates
    /// are dead) and resolve the next one from the new interface.
    func networkChanged()
    func shutdown()
}

/// No RTC in this session. Tests inject this unless they exercise the RTC
/// commands; it still answers every command so the coordinator never waits.
public struct UnavailableRtcPlatform: RtcPlatform {
    public init() {}

    public func createPeer(
        peer: UInt64,
        stun: [String],
        sink: @escaping @Sendable (SessionEvent) -> Void
    ) {
        sink(.rtcClosed(peer: peer, reason: "WebRTC is not available in this session"))
    }
    public func acceptAnswer(peer: UInt64, sdp: String) {}
    public func send(peer: UInt64, bytes: Data) {}
    public func closePeer(peer: UInt64) {}
    public func networkChanged() {}
    public func shutdown() {}
}

/// The live platform. The queue is the only owner of `peers` and of every
/// `RtcPeer` handle, so no engine call can overlap another; the session's
/// loop only dispatches work here.
public final class LiveRtcPlatform: RtcPlatform, @unchecked Sendable {
    private let queue = DispatchQueue(label: "build.kieran.pinomad.rtc")
    private var peers: [UInt64: Peer] = [:]

    private final class Peer {
        let engine: RtcPeer
        let sockets: [PeerSocket]
        let sink: @Sendable (SessionEvent) -> Void
        var timer: DispatchSourceTimer?
        var timerGeneration: UInt64 = 0
        var nextDeadline: UInt64?
        /// A peer retired by `networkChanged`/close must swallow a timer or
        /// socket callback that was already queued.
        var closed = false

        init(
            engine: RtcPeer,
            sockets: [PeerSocket],
            sink: @escaping @Sendable (SessionEvent) -> Void
        ) {
            self.engine = engine
            self.sockets = sockets
            self.sink = sink
        }
    }

    /// One UDP socket and its receive loop. The engine addresses a transmit
    /// with `source`, the same string this record stores.
    private final class PeerSocket {
        let address: String
        let socket: RtcUdpSocket
        let source: DispatchSourceRead

        init(address: String, socket: RtcUdpSocket, source: DispatchSourceRead) {
            self.address = address
            self.socket = socket
            self.source = source
        }
    }

    public init() {}

    public func createPeer(
        peer: UInt64,
        stun: [String],
        sink: @escaping @Sendable (SessionEvent) -> Void
    ) {
        queue.async { [weak self] in
            self?.start(peer: peer, stun: stun, sink: sink)
        }
    }

    public func acceptAnswer(peer: UInt64, sdp: String) {
        queue.async { [weak self] in
            guard let self, let runtime = self.peers[peer] else { return }
            self.handle(peer: peer, actions: runtime.engine.acceptAnswer(nowMs: self.nowMs(), sdp: sdp))
        }
    }

    public func send(peer: UInt64, bytes: Data) {
        queue.async { [weak self] in
            guard let self, let runtime = self.peers[peer] else {
                // The coordinator already retired it; report the write as
                // not accepted so it never treats the record as delivered.
                return
            }
            let write = runtime.engine.send(nowMs: self.nowMs(), bytes: bytes)
            self.handle(peer: peer, actions: write.actions)
            runtime.sink(.rtcSendResult(peer: peer, outcome: write.outcome))
        }
    }

    public func closePeer(peer: UInt64) {
        queue.async { [weak self] in
            self?.retire(peer: peer, reason: nil)
        }
    }

    public func networkChanged() {
        queue.async { [weak self] in
            guard let self else { return }
            for peer in Array(self.peers.keys) {
                self.retire(peer: peer, reason: "the network interface changed")
            }
        }
    }

    public func shutdown() {
        queue.sync {
            for peer in Array(peers.keys) {
                retire(peer: peer, reason: nil)
            }
        }
    }

    private func nowMs() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1_000_000
    }

    private func start(
        peer: UInt64,
        stun: [String],
        sink: @escaping @Sendable (SessionEvent) -> Void
    ) {
        guard peers[peer] == nil else { return }
        let addresses = NetworkInterfaces.rtcAddresses()
        guard !addresses.isEmpty else {
            let reason = "this device has no usable network interface"
            rtcLogger.error("rtc peer \(peer): \(reason, privacy: .public)")
            sink(.rtcClosed(peer: peer, reason: reason))
            return
        }
        let prepared: ([NetworkAddress], [String])
        do {
            prepared = try Self.prepare(stun: stun, addresses: addresses)
        } catch {
            rtcLogger.error("rtc peer \(peer): \(error.localizedDescription, privacy: .public)")
            sink(.rtcClosed(peer: peer, reason: error.localizedDescription))
            return
        }
        let (locals, resolved) = prepared
        var bound: [(NetworkAddress, RtcUdpSocket)] = []
        for local in locals {
            guard let socket = RtcUdpSocket(bind: local) else {
                rtcLogger.error(
                    "rtc peer \(peer): could not bind \(local.interface, privacy: .public)")
                continue
            }
            bound.append((local, socket))
        }
        guard !bound.isEmpty else {
            let reason = "could not bind a UDP socket on any selected interface"
            rtcLogger.error("rtc peer \(peer): \(reason, privacy: .public)")
            sink(.rtcClosed(peer: peer, reason: reason))
            return
        }
        let engine: RtcPeer
        do {
            engine = try RtcPeer(
                localAddrs: bound.map { $0.0.socketAddress(port: $0.1.port) },
                stunServers: resolved,
                nowMs: nowMs())
        } catch {
            for (_, socket) in bound { socket.close() }
            let reason = "the RTC engine could not start: \(error)"
            rtcLogger.error("rtc peer \(peer): \(reason, privacy: .public)")
            sink(.rtcClosed(peer: peer, reason: reason))
            return
        }
        var sockets: [PeerSocket] = []
        for (local, socket) in bound {
            let address = local.socketAddress(port: socket.port)
            let source = DispatchSource.makeReadSource(fileDescriptor: socket.fd, queue: queue)
            let runtime = PeerSocket(address: address, socket: socket, source: source)
            source.setEventHandler { [weak self] in
                self?.receive(peer: peer, local: address)
            }
            // libdispatch only guarantees the descriptor is no longer used
            // after the cancellation handler runs. Closing it at cancel()
            // time could let a newly created Peer reuse the fd while the old
            // source drains.
            source.setCancelHandler { [socket] in
                socket.close()
            }
            sockets.append(runtime)
        }
        peers[peer] = Peer(engine: engine, sockets: sockets, sink: sink)
        for runtime in sockets { runtime.source.resume() }
        let actions = engine.start(nowMs: nowMs())
        handle(peer: peer, actions: actions)
    }

    /// One sequential receive loop per socket. They share the serial queue,
    /// so every datagram enters the engine in the order its socket read it.
    private func receive(peer: UInt64, local: String) {
        guard let runtime = peers[peer], !runtime.closed,
              let socket = runtime.sockets.first(where: { $0.address == local })
        else { return }
        for datagram in socket.socket.receive() {
            if runtime.closed { return }
            let actions = runtime.engine.receive(
                nowMs: nowMs(), local: local, source: datagram.source, bytes: datagram.bytes)
            handle(peer: peer, actions: actions)
        }
    }

    private func timerFired(peer: UInt64, generation: UInt64) {
        guard let runtime = peers[peer], !runtime.closed,
              runtime.timerGeneration == generation
        else { return }
        runtime.timer = nil
        runtime.nextDeadline = nil
        let actions = runtime.engine.timeout(nowMs: nowMs())
        handle(peer: peer, actions: actions)
    }

    private func handle(peer: UInt64, actions: [RtcAction]) {
        guard let runtime = peers[peer], !runtime.closed else { return }
        for action in actions {
            switch action {
            case .transmit(let source, let destination, let bytes):
                // UDP is lossy by design; a failed send is a dropped packet,
                // not a closed carrier. ICE/DTLS retransmission covers it and
                // the stall timer remains the only "no progress" verdict.
                runtime.sockets.first(where: { $0.address == source })?
                    .socket.send(bytes, to: destination)
            case .schedule(let atMs):
                arm(peer: peer, atMs: atMs)
            case .localOffer(let sdp):
                runtime.sink(.rtcPeerReady(peer: peer, sdp: sdp))
            case .channelOpened:
                runtime.sink(.rtcChannelOpened(peer: peer))
            case .data(let bytes):
                runtime.sink(.rtcData(peer: peer, bytes: bytes))
            case .bufferedAmountLow:
                runtime.sink(.rtcLowWater(peer: peer))
            case .selectedCandidate(let local, let remote):
                runtime.sink(.rtcSelectedCandidate(peer: peer, local: local, remote: remote))
            case .closed(let reason):
                retire(peer: peer, reason: reason)
            }
        }
    }

    /// Arm the Peer's single timer. A later schedule replaces the previous
    /// one, and the cancellation generation makes a queued handler harmless.
    private func arm(peer: UInt64, atMs: UInt64) {
        guard let runtime = peers[peer], !runtime.closed else { return }
        runtime.timer?.setEventHandler {}
        runtime.timer?.cancel()
        runtime.timerGeneration &+= 1
        let generation = runtime.timerGeneration
        let now = nowMs()
        let delayMs = atMs > now ? atMs - now : 0
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(Int(delayMs)))
        timer.setEventHandler { [weak self] in
            self?.timerFired(peer: peer, generation: generation)
        }
        runtime.timer = timer
        runtime.nextDeadline = atMs
        timer.resume()
    }

    private func retire(peer: UInt64, reason: String?) {
        if let reason {
            rtcLogger.notice("rtc peer \(peer) retired: \(reason, privacy: .public)")
        }
        guard let runtime = peers.removeValue(forKey: peer) else { return }
        runtime.closed = true
        runtime.timer?.setEventHandler {}
        runtime.timer?.cancel()
        runtime.timer = nil
        for socket in runtime.sockets { socket.source.cancel() }
        runtime.engine.close()
        if let reason {
            runtime.sink(.rtcClosed(peer: peer, reason: reason))
        }
    }

    /// Resolve STUN once per selected address family. One family failing
    /// costs that family only: the peer continues on the other socket. TURN
    /// is unsupported, so when every family rejects the list the peer fails
    /// with the first concrete error.
    private static func prepare(
        stun: [String],
        addresses: [NetworkAddress]
    ) throws -> ([NetworkAddress], [String]) {
        guard !stun.isEmpty else { return (addresses, []) }
        var kept: [NetworkAddress] = []
        var servers: [String] = []
        var failure: (any Error)?
        for address in addresses {
            do {
                let resolved = try resolve(stun: stun, ipv6: address.isIPv6)
                kept.append(address)
                for server in resolved where !servers.contains(server) {
                    servers.append(server)
                }
            } catch {
                let family = address.isIPv6 ? "IPv6" : "IPv4"
                rtcLogger.error(
                    "rtc: dropping \(family, privacy: .public) STUN on \(address.interface, privacy: .public): \(error.localizedDescription, privacy: .public)")
                failure = failure ?? error
            }
        }
        guard !kept.isEmpty else {
            throw failure
                ?? RtcPlatformError.unresolvedServer(stun.joined(separator: ", "))
        }
        return (kept, servers)
    }

    /// Parse `stun:host[:port]` and resolve it for the socket's family.
    /// TURN is out of scope (ADR-0033 §1): a `turn:` URL fails the peer
    /// instead of being silently ignored.
    private static func resolve(stun: [String], ipv6: Bool) throws -> [String] {
        guard !stun.isEmpty else { return [] }
        var resolved: [String] = []
        for raw in stun {
            guard raw.hasPrefix("stun:") else {
                throw RtcPlatformError.unsupportedServer(raw)
            }
            let (host, port) = try splitHostPort(String(raw.dropFirst("stun:".count)), default: 3478)
            var hints = addrinfo(
                ai_flags: 0,
                ai_family: ipv6 ? AF_INET6 : AF_INET,
                ai_socktype: SOCK_DGRAM,
                ai_protocol: IPPROTO_UDP,
                ai_addrlen: 0,
                ai_canonname: nil,
                ai_addr: nil,
                ai_next: nil)
            var result: UnsafeMutablePointer<addrinfo>?
            let status = getaddrinfo(host, String(port), &hints, &result)
            guard status == 0, let result else {
                throw RtcPlatformError.unresolvedServer(raw)
            }
            defer { freeaddrinfo(result) }
            for entry in sequence(first: result, next: { $0.pointee.ai_next }) {
                guard let address = entry.pointee.ai_addr else { continue }
                var storage = sockaddr_storage()
                let length = Int(entry.pointee.ai_addrlen)
                guard length <= MemoryLayout<sockaddr_storage>.size else { continue }
                withUnsafeMutableBytes(of: &storage) { target in
                    target.copyBytes(from: UnsafeRawBufferPointer(
                        start: address, count: length))
                }
                var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let rendered = withUnsafePointer(to: &storage) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                        getnameinfo(
                            sockaddrPointer, socklen_t(length),
                            &hostBuffer, socklen_t(hostBuffer.count), nil, 0, NI_NUMERICHOST)
                    }
                }
                guard rendered == 0 else { continue }
                let text = platformCString(hostBuffer)
                let entryText = text.contains(":") ? "[\(text)]:\(port)" : "\(text):\(port)"
                if !resolved.contains(entryText) { resolved.append(entryText) }
            }
        }
        guard !resolved.isEmpty else {
            throw RtcPlatformError.unresolvedServer(stun.joined(separator: ", "))
        }
        return resolved
    }

    private static func splitHostPort(_ text: String, default port: UInt16) throws -> (String, UInt16) {
        if text.hasPrefix("[") {
            guard let close = text.firstIndex(of: "]") else {
                throw RtcPlatformError.unsupportedServer(text)
            }
            let host = String(text[text.index(after: text.startIndex)..<close])
            let after = text.index(after: close)
            if after == text.endIndex { return (host, port) }
            guard text[after] == ":", let number = UInt16(text[text.index(after: after)...]) else {
                throw RtcPlatformError.unsupportedServer(text)
            }
            return (host, number)
        }
        guard let colon = text.lastIndex(of: ":") else { return (text, port) }
        let host = String(text[..<colon])
        guard let number = UInt16(text[text.index(after: colon)...]) else {
            throw RtcPlatformError.unsupportedServer(text)
        }
        return (host, number)
    }
}

private enum RtcPlatformError: LocalizedError {
    case unsupportedServer(String)
    case unresolvedServer(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedServer(let server):
            "Unsupported STUN server \(server); only stun: URLs are implemented."
        case .unresolvedServer(let server):
            "Could not resolve STUN server \(server)."
        }
    }
}

/// The engine's UDP socket: one bound port for STUN, DTLS and SCTP, so the
/// host candidate the engine advertises is exactly where datagrams arrive.
final class RtcUdpSocket {
    private(set) var fd: Int32
    let port: UInt16

    init?(bind local: NetworkAddress) {
        let family = local.isIPv6 ? AF_INET6 : AF_INET
        let descriptor = socket(family, SOCK_DGRAM, IPPROTO_UDP)
        guard descriptor >= 0 else { return nil }
        var one: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let flags = fcntl(descriptor, F_GETFL, 0)
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        var storage = sockaddr_storage()
        var length: socklen_t = 0
        if local.isIPv6 {
            var addr = sockaddr_in6()
            addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            addr.sin6_family = sa_family_t(AF_INET6)
            addr.sin6_port = 0
            guard inet_pton(AF_INET6, local.address, &addr.sin6_addr) == 1 else {
                _ = Darwin.close(descriptor)
                return nil
            }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: raw) }
            }
            length = socklen_t(MemoryLayout<sockaddr_in6>.size)
        } else {
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = 0
            guard inet_pton(AF_INET, local.address, &addr.sin_addr) == 1 else {
                _ = Darwin.close(descriptor)
                return nil
            }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: raw) }
            }
            length = socklen_t(MemoryLayout<sockaddr_in>.size)
        }
        let bound = withUnsafePointer(to: &storage) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(descriptor, sockaddrPointer, length)
            }
        }
        guard bound == 0 else {
            _ = Darwin.close(descriptor)
            return nil
        }
        var name = sockaddr_storage()
        var nameLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let named = withUnsafeMutablePointer(to: &name) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getsockname(descriptor, sockaddrPointer, &nameLength)
            }
        }
        guard named == 0 else {
            _ = Darwin.close(descriptor)
            return nil
        }
        switch Int32(name.ss_family) {
        case AF_INET:
            port = withUnsafePointer(to: &name) { pointer in
                pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                    UInt16(bigEndian: $0.pointee.sin_port)
                }
            }
        case AF_INET6:
            port = withUnsafePointer(to: &name) { pointer in
                pointer.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                    UInt16(bigEndian: $0.pointee.sin6_port)
                }
            }
        default:
            _ = Darwin.close(descriptor)
            return nil
        }
        fd = descriptor
    }

    deinit { close() }

    func close() {
        if fd >= 0 {
            _ = Darwin.close(fd)
            fd = -1
        }
    }

    func send(_ bytes: Data, to destination: String) {
        guard fd >= 0, let address = RtcSocketAddress(rendered: destination) else { return }
        _ = bytes.withUnsafeBytes { raw in
            address.withSockAddr { pointer, length in
                Darwin.sendto(fd, raw.baseAddress, raw.count, 0, pointer, length)
            }
        }
    }

    /// Every datagram currently queued, with its numeric source. One
    /// `recvfrom` per call keeps each datagram's engine mutation contiguous.
    func receive() -> [(source: String, bytes: Data)] {
        guard fd >= 0 else { return [] }
        var out: [(source: String, bytes: Data)] = []
        // A full 65,535-byte Noise record plus DTLS/SCTP framing can exceed
        // 64 KiB; truncating it would stall the record stream silently.
        var buffer = [UInt8](repeating: 0, count: 128 * 1024)
        while true {
            var storage = sockaddr_storage()
            var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
            let count = withUnsafeMutablePointer(to: &storage) { storagePointer in
                storagePointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                    buffer.withUnsafeMutableBytes { raw in
                        Darwin.recvfrom(fd, raw.baseAddress, raw.count, 0, sockaddrPointer, &length)
                    }
                }
            }
            if count < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { break }
                break
            }
            let source = Self.render(&storage, length: length)
            out.append((source: source, bytes: Data(buffer[0..<count])))
        }
        return out
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
        let ip = platformCString(host)
        let port = platformCString(service)
        return ip.contains(":") ? "[\(ip)]:\(port)" : "\(ip):\(port)"
    }
}

/// Parses the numeric `ip:port` / `[v6]:port` form used across the RTC path.
private struct RtcSocketAddress {
    private var storage = sockaddr_storage()
    private var length: socklen_t = 0

    init?(rendered: String) {
        let host: String
        let portText: String
        if rendered.hasPrefix("[") {
            guard let close = rendered.firstIndex(of: "]") else { return nil }
            host = String(rendered[rendered.index(after: rendered.startIndex)..<close])
            let after = rendered.index(after: close)
            guard after < rendered.endIndex, rendered[after] == ":" else { return nil }
            portText = String(rendered[rendered.index(after: after)...])
        } else {
            guard let colon = rendered.lastIndex(of: ":") else { return nil }
            host = String(rendered[..<colon])
            portText = String(rendered[rendered.index(after: colon)...])
        }
        guard let port = UInt16(portText) else { return nil }
        if host.contains(":") {
            var addr = sockaddr_in6()
            addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            addr.sin6_family = sa_family_t(AF_INET6)
            addr.sin6_port = port.bigEndian
            guard inet_pton(AF_INET6, host, &addr.sin6_addr) == 1 else { return nil }
            withUnsafeBytes(of: &addr) { raw in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: raw) }
            }
            length = socklen_t(MemoryLayout<sockaddr_in6>.size)
        } else {
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else { return nil }
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
