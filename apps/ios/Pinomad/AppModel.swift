import Foundation
import PinomadCore
import UIKit

/// The app's one session and its UI-facing state. 3b scope: paste a
/// pairing link (or auto-reconnect the stored host) and show connection
/// status + conversation count.
@MainActor @Observable
final class AppModel {
    enum Phase: Equatable {
        case loading
        /// No stored host — waiting for a pasted link.
        case pairing
        case connecting
        case connected
        case failed(String)
    }

    var phase: Phase = .loading
    var link = ""
    var hostURL = ""
    var connectionText = ""
    var conversationCount = 0
    var lastError = ""

    private(set) var session: PinomadSession?
    private var watchTask: Task<Void, Never>?
    private let store = KeychainHostStore()
    private let monitor = NetworkMonitor()

    func start() {
        // The monitor runs for the app's lifetime; it only yields into
        // whatever session exists at the moment.
        monitor.start { [weak self] in
            Task { @MainActor in self?.session?.notifyNetworkChanged() }
        }
        // Dev seam for scripted runs: `-pairingLink <url>` pre-fills the
        // field, `-autoPair` connects straight away.
        let args = UserDefaults.standard
        if let injected = args.string(forKey: "pairingLink"), !injected.isEmpty {
            link = injected
            if args.bool(forKey: "autoPair") {
                pair()
                return
            }
        }
        do {
            if let host = try store.load().active {
                connect(host)
            } else {
                phase = .pairing
            }
        } catch {
            phase = .failed("读取配对信息失败：\(error.localizedDescription)")
        }
    }

    func pair() {
        let pasted = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pasted.isEmpty else { return }
        do {
            let session = try PinomadSession.pair(
                link: pasted, deviceName: UIDevice.current.name)
            adopt(session)
        } catch {
            phase = .failed("配对链接无效")
        }
    }

    /// Re-read the keychain and connect again (e.g. after a failure).
    func retry() {
        phase = .loading
        start()
    }

    /// Drop all stored pairings and go back to the link screen.
    func forgetHost() {
        watchTask?.cancel()
        session?.close()
        session = nil
        try? store.save(StoredHosts())
        phase = .pairing
    }

    func didEnterForeground() { session?.notifyForeground() }
    func didEnterBackground() { session?.notifyBackground() }

    private func connect(_ host: HostRecord) {
        do {
            let session = try PinomadSession.connect(host: host)
            adopt(session)
            hostURL = host.url
        } catch {
            phase = .failed("无法连接：\(error.localizedDescription)")
        }
    }

    private func adopt(_ session: PinomadSession) {
        self.session?.close()
        self.session = session
        phase = .connecting
        connectionText = "正在连接…"
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            for await update in session.updates {
                self?.apply(update)
            }
        }
    }

    private func apply(_ update: SessionUpdate) {
        switch update {
        case .ready(let outcome):
            switch outcome {
            case .connected:
                phase = .connected
                // The host URL only becomes known once `Paired` lands.
                if hostURL.isEmpty {
                    hostURL = (try? store.load().active?.url) ?? ""
                }
            case .unauthorized:
                phase = .failed("设备未授权（配对可能已被撤销）")
            case .mismatch(_, _, let direction, let hostVersion):
                phase = .failed(
                    "协议版本不兼容（\(direction)，宿主 \(hostVersion ?? "未知")）")
            case .error(let message):
                phase = .failed(message)
            }
        case .snapshot(let snapshot):
            connectionText = label(for: snapshot.connection)
            conversationCount = snapshot.organized.chats.count
                + snapshot.organized.projects.reduce(0) { $0 + $1.conversations.count }
        case .platformError(let message):
            lastError = message
        }
    }

    private func label(for connection: ConnectionState) -> String {
        switch connection {
        case .connected: "已连接"
        case .reconnecting: "重连中…"
        case .closed: "已断开"
        case .outdated: "协议版本过旧"
        }
    }
}
