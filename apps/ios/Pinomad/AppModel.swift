import Foundation
import OSLog
import AgentChatKit
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
    var lastError = ""
    /// The newest published view — the list and the open conversation
    /// both read straight off it; nothing here re-derives its contents.
    private(set) var snapshot: ClientSnapshot?
    /// NavigationStack path — conversation ids pushed onto it open that
    /// conversation's screen.
    var navPath: [UInt64] = []
    /// Live answer streams, keyed by run entry id. Owned here rather than
    /// in view state: feeding them from LazyVStack rows' onAppear/onChange
    /// kept the iOS 27 layout unsettled (the whole transcript rendered
    /// blank). Snapshot-driven sync in `apply` is side-effect free for the
    /// view tree.
    private var streams: [String: StreamingMarkdown] = [:]
    /// Set by `-openConversation <id>` — pushed once connected.
    private var pendingOpen: UInt64?

    private(set) var session: PinomadSession?
    private var watchTask: Task<Void, Never>?
    private let store = KeychainHostStore()
    private let monitor = NetworkMonitor()
    /// Marks each snapshot landing on the main actor — paired with the
    /// session's `bytes`/`publish` events for the byte-to-UI latency.
    private let signposter = OSSignposter(subsystem: "build.kieran.pinomad", category: "delivery")

    func start() {
        // The monitor runs for the app's lifetime; it only yields into
        // whatever session exists at the moment.
        monitor.start { [weak self] in
            Task { @MainActor in self?.session?.notifyNetworkChanged() }
        }
        // Dev seam for scripted runs: `-pairingLink <url>` pre-fills the
        // field, `-autoPair` connects straight away. devicectl cannot pass
        // single-dash args to a device app (it clusters them as its own
        // short options), so the same three values are also read from
        // PINOMAD_* environment variables.
        let args = UserDefaults.standard
        let env = ProcessInfo.processInfo.environment
        if env["PINOMAD_KEEPSCREEN"] != nil {
            // Perf runs: keep the phone awake so a scripted measurement
            // window isn't cut short by auto-lock.
            UIApplication.shared.isIdleTimerDisabled = true
        }
        if let openId = args.string(forKey: "openConversation") ?? env["PINOMAD_OPEN"],
           let n = UInt64(openId) {
            pendingOpen = n
        }
        let injected = args.string(forKey: "pairingLink") ?? env["PINOMAD_PAIRING_LINK"] ?? ""
        if !injected.isEmpty {
            link = injected
            if args.bool(forKey: "autoPair") || env["PINOMAD_AUTOPAIR"] != nil {
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

    /// Show and talk to a conversation — command-class, so a refused
    /// switch surfaces as a snapshot notice, not a thrown error.
    func openConversation(_ id: UInt64) {
        Task { [weak self] in
            _ = try? await self?.session?.invoke(.switchConversation(id: id))
        }
    }

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
        // A new session is a new host — display state from the previous
        // one (URL, snapshots, errors) must not bleed into this screen.
        hostURL = ""
        snapshot = nil
        lastError = ""
        streams.removeAll()
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
                hostURL = (try? store.load().active?.url) ?? hostURL
                if let id = pendingOpen {
                    pendingOpen = nil
                    navPath = [id]
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
            if snapshot.unauthorized {
                // Terminal: the host revoked this device (close 4401).
                // The failure screen's re-pair path is the only way out.
                connectionText = "未授权（设备已被吊销）"
                phase = .failed("设备已被吊销")
            } else {
                connectionText = label(for: snapshot.connection)
            }
            self.snapshot = snapshot
            signposter.emitEvent("ui-publish")
            syncStreams(snapshot)
            PerfLog.shared.mark("ui-publish", version: snapshot.version)
            // Perf runs double as field diagnostics: which conversation is
            // shown and how many chat rows it carries.
            if let c = snapshot.conversation {
                PerfLog.shared.mark("conv-\(c.id)-\(c.chat.count)")
            }
            PerfLog.shared.flush()
        case .platformError(let message):
            lastError = message
        }
    }

    /// The stream a run's answer is being revealed through, or nil while
    /// no answer has arrived.
    func streamFor(_ entryId: String) -> StreamingMarkdown? { streams[entryId] }

    /// Feed each run's whole answer text into its stream — the snapshot
    /// always carries the full text, so only the arrived suffix is appended;
    /// a rewrite (non-prefix) restarts the stream rather than replaying.
    private func syncStreams(_ snapshot: ClientSnapshot) {
        guard let chat = snapshot.conversation?.chat else { return }
        for entry in chat {
            guard case let .run(id, cot, _, _, _) = entry, let answer = cot.answer else { continue }
            let stream = streams[id] ?? StreamingMarkdown(pace: answer.streaming ? .standard : nil)
            if answer.text.hasPrefix(stream.markdown) {
                let delta = answer.text.dropFirst(stream.markdown.count)
                // A finished stream may still see a rewritten tail — start
                // over instead of tripping append-after-finish.
                if !delta.isEmpty, stream.stream.isFinished {
                    let fresh = StreamingMarkdown(pace: nil)
                    fresh.append(answer.text)
                    fresh.finish()
                    streams[id] = fresh
                    continue
                }
                if !delta.isEmpty { stream.append(String(delta)) }
            } else {
                let fresh = StreamingMarkdown(pace: nil)
                fresh.append(answer.text)
                fresh.finish()
                streams[id] = fresh
                continue
            }
            if !answer.streaming { stream.finish() }
            streams[id] = stream
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
