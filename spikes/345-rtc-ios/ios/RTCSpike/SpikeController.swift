import Foundation
import SwiftUI
import UIKit

final class SpikeController: ObservableObject {
    @Published private(set) var status = "idle"
    @Published private(set) var detail = ""
    @Published private(set) var logLines: [String] = []

    private let io = DispatchQueue(label: "build.kieran.pinomad.rtcspike.io")
    private let environment = ProcessInfo.processInfo.environment
    private let logger = FileLogger()
    private var engine: SpikePeer?
    private var socket: UDPSocket?
    private var timer: DispatchSourceTimer?
    private var nextDeadline: UInt64?
    private var started = false
    private var stopping = false
    private var terminal = false
    private var lastStatus = ""
    private var transmitCount = 0

    func startIfNeeded() {
        guard !started else { return }
        started = true
        io.async { [weak self] in self?.start() }
    }

    private func start() {
        let server = environment["RTCSPIKE_SERVER"] ?? "http://127.0.0.1:8765"
        let family = environment["RTCSPIKE_FAMILY"] ?? "auto"
        let seed = UInt64(environment["RTCSPIKE_SEED"] ?? "7") ?? 7
        let header = [
            "=== RTC spike start \(Date()) ===",
            "bundle=\(Bundle.main.bundleIdentifier ?? "?") device=\(UIDevice.current.model) os=\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            "server=\(server) family=\(family) seed=\(seed)",
            "env=\(environment.filter { $0.key.hasPrefix("RTCSPIKE_") })",
            "NSBonjourServices=\(Bundle.main.object(forInfoDictionaryKey: "NSBonjourServices") ?? "absent")",
        ]
        header.forEach { log($0) }

        let explicit = environment["RTCSPIKE_BIND"]
        let chosen: NetworkResolver.LocalAddress?
        if let explicit, !explicit.isEmpty {
            chosen = NetworkResolver.LocalAddress(interface: "override", address: explicit)
        } else if family == "ipv6" {
            chosen = NetworkResolver.primary(family: "ipv6")
        } else {
            chosen = NetworkResolver.primary(family: "ipv4") ?? NetworkResolver.primary(family: "ipv6")
        }
        guard let local = chosen else {
            finishFailure("no usable network interface")
            return
        }
        let wantIPv6 = local.address.contains(":")
        log("interface=\(local.interface) address=\(local.address) family=\(wantIPv6 ? "ipv6" : "ipv4")")

        guard let socket = UDPSocket(
            bind: local.address,
            queue: io,
            onDatagram: { [weak self] data, source in self?.receive(data, source) },
            onError: { [weak self] error in self?.log("socket: \(error)") }
        ) else {
            finishFailure("UDP socket bind failed")
            return
        }
        self.socket = socket
        guard let port = Self.port(of: socket.localAddress) else {
            finishFailure("could not read bound UDP port")
            return
        }
        log("udp bound \(socket.localAddress) fd receive loop ready")

        let stun = environment["RTCSPIKE_STUN"] ?? "stun.cloudflare.com:3478"
        let stunParts = Self.split(hostPort: stun)
        let stunServers = NetworkResolver.stunAddresses(
            host: stunParts.host,
            port: stunParts.port,
            wantIPv6: wantIPv6,
            override: environment["RTCSPIKE_STUN_ADDR"]
        )
        log("STUN config=\(stun) resolved=\(stunServers)")
        if stunServers.isEmpty {
            finishFailure("STUN resolved to no addresses")
            return
        }

        let rendered = local.address.contains(":")
            ? "[\(local.address)]:\(port)"
            : "\(local.address):\(port)"
        let dedupe = environment["RTCSPIKE_DEDUPE"] != "0"
        log("dedupe_duplicates=\(dedupe)")
        let config = SpikeConfig(
            localAddr: rendered,
            stunServers: stunServers,
            seed: seed,
            dedupeDuplicates: dedupe)
        let peer = SpikePeer(config: config, nowMs: nowMs())
        engine = peer
        log("engine created local=\(rendered)")
        handle(peer.start(nowMs: nowMs()))

        io.asyncAfter(deadline: .now() + 75) { [weak self] in
            self?.stop("watchdog: 75s without completion")
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        let name: String
        switch phase {
        case .active: name = "active"
        case .inactive: name = "inactive"
        case .background: name = "background"
        @unknown default: name = "unknown"
        }
        io.async { [weak self] in
            guard let self, self.engine != nil, !self.stopping else { return }
            self.log("APP scene=\(name) at \(self.nowMs())ms")
            if phase == .background {
                self.timer?.cancel()
                self.timer = nil
                self.log("APP paused timer, nextDeadline=\(String(describing: self.nextDeadline))")
            } else if phase == .active, let deadline = self.nextDeadline {
                if deadline <= self.nowMs() {
                    self.timerFired()
                } else {
                    self.arm(deadline)
                }
            }
        }
    }

    private func receive(_ data: Data, _ source: String) {
        guard let engine, !stopping else { return }
        handle(engine.receive(nowMs: nowMs(), source: source, bytes: data))
    }

    private func timerFired() {
        timer = nil
        nextDeadline = nil
        guard let engine, !stopping else { return }
        handle(engine.timeout(nowMs: nowMs()))
    }

    private func handle(_ actions: [SpikeAction]) {
        var next: UInt64?
        for action in actions {
            switch action {
            case .transmit(let destination, let bytes):
                transmitCount += 1
                guard let socket else { continue }
                if !socket.send(bytes, to: destination) {
                    log("send failed #\(transmitCount) -> \(destination) bytes=\(bytes.count)")
                } else if transmitCount <= 3 || transmitCount % 100 == 0 {
                    log("sent #\(transmitCount) -> \(destination) bytes=\(bytes.count)")
                }
            case .schedule(let atMs):
                next = atMs
            case .localOffer(let sdp):
                save("offer.sdp", sdp)
                let normalized = sdp.replacingOccurrences(of: "\r\n", with: "\n")
                let candidates = normalized.split(separator: "\n").filter { $0.hasPrefix("a=candidate:") }
                log("offer ready bytes=\(sdp.count) candidates=\(candidates.count)")
                candidates.forEach { log("offer \($0)") }
                postOffer(sdp)
            case .log(let line):
                log(line)
            case .iceState(let state):
                setStatus("ice:\(state)")
            case .candidatePair(let local, let remote, let localType, let remoteType):
                log("selected pair local=\(local)/\(localType) remote=\(remote)/\(remoteType)")
            case .channelOpen(let label):
                setStatus("channel open")
                log("DataChannel open label=\(label)")
            case .noiseReady(let hash):
                setStatus("noise ready")
                log("Noise IK ready hash=\(hash)")
            case .bulkSent(let records, let bytes, let writeFalse, let buffered):
                log("bulk sent records=\(records) bytes=\(bytes) writeFalse=\(writeFalse) buffered=\(buffered)")
            case .bulkReceived(let records, let bytes, let matched):
                log("bulk received records=\(records) bytes=\(bytes) matched=\(matched)")
            case .completed(let summary):
                terminal = true
                setStatus("complete")
                save("summary.txt", summary)
                log("COMPLETE \(summary)")
                let hold = UInt64(environment["RTCSPIKE_HOLD_MS"] ?? "5000") ?? 5000
                io.asyncAfter(deadline: .now() + .milliseconds(Int(hold))) { [weak self] in
                    self?.stop("complete + hold")
                }
            case .failed(let reason):
                terminal = true
                setStatus("failed")
                log("FAILED \(reason)")
                io.asyncAfter(deadline: .now() + 1) { [weak self] in self?.stop("failed") }
            case .closed(let reason):
                log("closed \(reason)")
            }
        }
        if !terminal, !stopping, let next {
            arm(next)
        }
    }

    private func arm(_ atMs: UInt64) {
        nextDeadline = atMs
        timer?.cancel()
        let delay = max(0.001, Double(atMs) / 1000.0 - ProcessInfo.processInfo.systemUptime)
        let source = DispatchSource.makeTimerSource(queue: io)
        source.schedule(deadline: .now() + delay)
        source.setEventHandler { [weak self] in self?.timerFired() }
        timer = source
        source.resume()
    }

    private func postOffer(_ sdp: String) {
        let base = environment["RTCSPIKE_SERVER"] ?? "http://127.0.0.1:8765"
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/offer") else {
            finishFailure("bad server URL")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "content-type")
        request.httpBody = Data(sdp.utf8)
        log("POST \(url) offerBytes=\(sdp.count)")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            self.io.async {
                if let error {
                    self.finishFailure("signalling POST failed: \(error)")
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                guard status == 200, let data, let answer = String(data: data, encoding: .utf8) else {
                    self.finishFailure("signalling answer status=\(status) bytes=\(data?.count ?? 0)")
                    return
                }
                self.save("answer.sdp", answer)
                self.log("answer received status=\(status) bytes=\(answer.count)")
                guard let engine = self.engine, !self.stopping else { return }
                self.handle(engine.acceptAnswer(nowMs: self.nowMs(), sdp: answer))
            }
        }.resume()
    }

    private func finishFailure(_ reason: String) {
        terminal = true
        setStatus("failed")
        log("FAILED \(reason)")
        io.asyncAfter(deadline: .now() + 1) { [weak self] in self?.stop("setup failed") }
    }

    private func stop(_ reason: String) {
        guard !stopping else { return }
        stopping = true
        timer?.cancel()
        timer = nil
        nextDeadline = nil
        log("STOP \(reason)")
        if let engine {
            for action in engine.stop(nowMs: nowMs()) {
                if case .log(let line) = action { log(line) }
            }
        }
        engine = nil
        socket?.close()
        socket = nil
        log("resources released: socket closed, timer cancelled, SpikePeer dropped, transmits=\(transmitCount)")
        setStatus("stopped")
    }

    private func setStatus(_ value: String) {
        guard value != lastStatus else { return }
        lastStatus = value
        DispatchQueue.main.async { self.status = value }
    }

    private func log(_ message: String) {
        let line = String(format: "%.3f %@", Date().timeIntervalSince1970, message)
        logger.write(line)
        DispatchQueue.main.async {
            self.logLines.append(line)
            if self.logLines.count > 250 { self.logLines.removeFirst(self.logLines.count - 250) }
            self.detail = message
        }
    }

    private func save(_ name: String, _ contents: String) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = documents.appendingPathComponent(name)
        try? contents.write(to: url, atomically: true, encoding: .utf8)
    }

    private func nowMs() -> UInt64 {
        UInt64(ProcessInfo.processInfo.systemUptime * 1000)
    }

    private static func port(of address: String) -> UInt16? {
        guard let colon = address.lastIndex(of: ":") else { return nil }
        return UInt16(address[address.index(after: colon)...])
    }

    private static func split(hostPort: String) -> (host: String, port: UInt16) {
        if hostPort.hasPrefix("[") {
            guard let close = hostPort.firstIndex(of: "]") else { return (hostPort, 3478) }
            let host = String(hostPort[hostPort.index(after: hostPort.startIndex)..<close])
            let after = hostPort.index(after: close)
            if after < hostPort.endIndex, hostPort[after] == ":" {
                return (host, UInt16(hostPort[hostPort.index(after: after)...]) ?? 3478)
            }
            return (host, 3478)
        }
        guard let colon = hostPort.lastIndex(of: ":"),
              let port = UInt16(hostPort[hostPort.index(after: colon)...]) else {
            return (hostPort, 3478)
        }
        return (String(hostPort[..<colon]), port)
    }
}
