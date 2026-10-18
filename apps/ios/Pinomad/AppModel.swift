import Foundation
import OSLog
import AgentChatKit
import PinomadChat
import PinomadCore
import UIKit

/// The app's one session and its UI-facing state: which host it talks to
/// (or which pairing link it is trying), how that ended, and everything the
/// screens read off the newest snapshot.
@MainActor @Observable
final class AppModel {
    enum Phase: Equatable {
        case loading
        /// No stored host — waiting for a link (pasted, scanned or opened).
        case pairing
        case connecting
        case connected
        case failed(ConnectFailure)
    }

    /// What the root presents as a sheet — one slot, so a deep link or a
    /// scan arriving while another sheet is up waits for it to close
    /// instead of being dropped by SwiftUI.
    enum Modal: Identifiable {
        case hosts
        case scanner
        case confirm(PendingPairing)

        var id: String {
            switch self {
            case .hosts: "hosts"
            case .scanner: "scanner"
            case .confirm(let pending): "confirm:\(pending.link)"
            }
        }
    }

    var phase: Phase = .loading
    var lastError = ""
    /// Every paired host and which one opens on launch, as last read from
    /// the keychain.
    private(set) var hosts = StoredHosts()
    /// The stored host the session talks to; nil while pairing.
    private(set) var currentHostKey: String?
    /// The link the session is pairing with; nil for a stored host.
    private(set) var pairingLink: String?
    /// Where the latest pairing went — names the session's host until the
    /// keychain has it (it may not, if saving the pairing failed).
    private(set) var pairingTarget: PairingTarget?
    var modal: Modal?
    private var nextModal: Modal?
    /// The newest published view — the list and the open conversation
    /// both read straight off it; nothing here re-derives its contents.
    private(set) var snapshot: ClientSnapshot?
    /// NavigationStack path.
    var navPath: [Route] = []
    /// Live answer streams, keyed by run entry id — the model side feeds
    /// them per snapshot so view rows stay side-effect free (lazy rows
    /// mutating their own @State kept iOS 27's layout unsettled; the
    /// transcript rendered blank).
    let replyStreams = ReplyStreams()
    /// Set by `-openConversation <id>` — pushed once connected.
    private var pendingOpen: UInt64?
    /// Unsent composer text per conversation — kept across navigation,
    /// dropped with the session (a new host has other conversations).
    var drafts: [UInt64: String] = [:]
    /// The new-conversation draft's home, checkout and model pick. Its text
    /// and images live in `drafts` / `trays` under `draftKey`.
    var draftHome: NewConversationHome = .chat
    var draftCheckout: ConversationCheckout = .worktree
    /// The reader's own pick; nil until they choose (then the host default
    /// is used). Kept across navigation, not across launches.
    var draftPick: ModelPick?
    /// A create is in flight — the draft page holds its send.
    var creating = false
    /// Staged images per conversation, beside its draft text.
    var trays: [UInt64: AttachmentTray] = [:]
    /// The message image shown full screen, if any.
    var viewing: MessageImage?
    /// In-progress answers per pending question request id.
    var questionDrafts: [String: QuestionDraft] = [:]
    /// Bumped when the reader acts at the transcript's end (sends, starts
    /// typing) — the transcript jumps back to its end on each change.
    var transcriptPin = 0
    /// A sheet is up and shows the toasts itself — the root stack steps
    /// aside so a notice isn't drawn twice.
    var sheetShowsToasts = false
    /// Notices currently shown as toasts, newest last.
    var toasts: [Notice] = []
    /// Which notices already toasted — one per session (ids restart).
    private var noticeFeed = NoticeFeed()

    private(set) var session: PinomadSession?
    private var watchTask: Task<Void, Never>?
    let store = KeychainHostStore()
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
        if env["PINOMAD_PERFLOG"] != nil {
            PerfLog.shared.startFrameMonitor()
        }
        if let openId = args.string(forKey: "openConversation") ?? env["PINOMAD_OPEN"],
           let n = UInt64(openId) {
            pendingOpen = n
        }
        let injected = args.string(forKey: "pairingLink") ?? env["PINOMAD_PAIRING_LINK"] ?? ""
        if !injected.isEmpty, args.bool(forKey: "autoPair") || env["PINOMAD_AUTOPAIR"] != nil {
            reloadHosts()
            pair(link: injected)
            // Scripted runs race the network coming up (tailnet,
            // VPN toggles) — keep retrying the injected link rather
            // than dropping the operator to a failed screen.
            if env["PINOMAD_AUTOPAIR"] != nil { schedulePairRetries(injected) }
            return
        }
        if env["PINOMAD_DEMO"] != nil {
            // No host needed: synthesize a streaming conversation so the
            // reply path (StreamingMarkdown + its fade) can be exercised
            // on a device that cannot reach one.
            phase = .connected
            startDemo()
            return
        }
        connectActive()
        if !injected.isEmpty { offerPairing(injected) }
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

    /// Retries the injected pairing link while the phase is a failure —
    /// only armed by PINOMAD_AUTOPAIR, so manual pairing stays manual.
    private var pairRetryTask: Task<Void, Never>?

    private func schedulePairRetries(_ link: String) {
        pairRetryTask?.cancel()
        pairRetryTask = Task { [weak self] in
            for _ in 0..<40 {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                if case .failed = self.phase {
                    self.pair(link: link)
                } else {
                    return
                }
            }
        }
    }

    /// Start a session pairing with `link` — replaces whatever session ran.
    func pair(link: String) {
        do {
            let session = try PinomadSession.pair(link: link, deviceName: UIDevice.current.name)
            adopt(session)
            currentHostKey = nil
            pairingLink = link
            pairingTarget = PinomadCore.pairingTarget(link: link)
        } catch {
            // Links reach here through `offerPairing`, which already parsed
            // them — this is the core refusing to build the session.
            fail(.unreachable(describe(error)))
        }
    }

    /// Start a session for a stored host.
    func connect(_ host: HostRecord) {
        do {
            let session = try PinomadSession.connect(host: host)
            adopt(session)
            currentHostKey = host.hostKey
            pairingLink = nil
            pairingTarget = nil
        } catch {
            fail(.unreachable(describe(error)))
        }
    }

    /// Re-read the keychain and connect to the launch host, or wait for a
    /// link when there is none.
    func connectActive() {
        do {
            hosts = try store.load()
        } catch {
            closeSession()
            fail(.unreachable("读取配对信息失败：\(describe(error))"))
            return
        }
        if let host = hosts.active {
            connect(host)
        } else {
            closeSession()
            phase = .pairing
        }
    }

    /// Refresh `hosts` from the keychain; a failed read keeps the last
    /// good list (connecting reports it, see `connectActive`).
    func reloadHosts() {
        if let stored = try? store.load() { hosts = stored }
    }

    func fail(_ failure: ConnectFailure) {
        phase = .failed(failure)
        // The failure screen replaces the list; pages pushed over it
        // would keep showing a session that is gone.
        navPath = []
    }

    /// Present `next`, after the current sheet (if any) has gone.
    func present(_ next: Modal) {
        if modal == nil {
            modal = next
        } else {
            nextModal = next
            modal = nil
        }
    }

    /// The root sheet's onDismiss — shows whatever was waiting for it.
    func modalDismissed() {
        guard let next = nextModal else { return }
        nextModal = nil
        modal = next
    }

    private func closeSession() {
        watchTask?.cancel()
        watchTask = nil
        session?.close()
        session = nil
        snapshot = nil
        currentHostKey = nil
        pairingLink = nil
        pairingTarget = nil
    }

    private func adopt(_ session: PinomadSession) {
        self.session?.close()
        self.session = session
        // A new session is a new host — display state from the previous
        // one (snapshots, errors, pages) must not bleed into this screen.
        snapshot = nil
        navPath = []
        lastError = ""
        replyStreams.sync(chat: nil)
        drafts = [:]
        questionDrafts = [:]
        trays = [:]
        viewing = nil
        draftHome = .chat
        draftCheckout = .worktree
        draftPick = nil
        toasts = []
        noticeFeed = NoticeFeed()
        phase = .connecting
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
            if let failure = ConnectFailure(outcome: outcome, pairing: pairingLink != nil) {
                fail(failure)
                return
            }
            if pairingLink != nil {
                // `Paired` lands before the first view and the session
                // stores the host then — from here on it is that host,
                // named by the link's key (not "whatever is active": a
                // failed keychain write leaves the previous host active).
                reloadHosts()
                currentHostKey = pairingTarget?.hostKey
                pairingLink = nil
                if let key = currentHostKey, !hosts.hosts.contains(where: { $0.hostKey == key }) {
                    lastError = "没能记住这台宿主：重启 App 后会回到之前的宿主，要再用它得重新配对。"
                }
            }
            phase = .connected
            if let id = pendingOpen {
                pendingOpen = nil
                navPath = [.conversation(id)]
            }
        case .snapshot(let snapshot):
            // Terminal after the first view: revoked (4401) or a hello
            // with another protocol major.
            if let failure = ConnectFailure(snapshot: snapshot) {
                fail(failure)
            }
            self.snapshot = snapshot
            // A failure page explains itself; the core's notice for the
            // same thing (e.g. the 4401) would only repeat it in English.
            for notice in noticeFeed.fresh(snapshot.notices) where phase == .connected { show(notice) }
            signposter.emitEvent("ui-publish")
            replyStreams.sync(chat: snapshot.conversation?.chat)
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
    func streamFor(_ entryId: String) -> StreamingMarkdown? { replyStreams.stream(for: entryId) }

    /// Drives a synthetic streaming answer — the same snapshot/sync path
    /// the session uses, so a blank screen reproduces exactly what the
    /// host-driven view would show.
    private func startDemo() {
        navPath = [.conversation(1)]
        let body = """
        这是一段流式输出的演示。**Markdown** 会逐词显现，应该能看到淡入效果。

        ## 小节标题

        - 列表项一：内容逐渐增长
        - 列表项二：接着出现
        - 列表项三：验证节奏

        ```swift
        let stream = StreamingMarkdown()
        stream.append("hello")
        ```

        一段收尾的正文，到这里回答就基本结束了。
        """
        let words = (0..<3).map { _ in body }.joined()
        var text = ""
        var version: UInt64 = 0
        Task { [weak self] in
            for (i, ch) in words.enumerated() {
                guard let self, !Task.isCancelled else { return }
                text.append(ch)
                self.demoPublish(answer: text, streaming: i < words.count - 1, version: &version)
                try? await Task.sleep(for: .milliseconds(40))
            }
        }
    }

    private func demoPublish(answer: String, streaming: Bool, version: inout UInt64) {
        version += 1
        let cot = CotView(
            phase: streaming ? .answering : .settled, failed: false,
            anchorMs: nil, elapsedMs: nil, steps: [],
            answer: CotAnswer(text: answer, streaming: streaming)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "演示一轮流式输出", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conv = ConversationSnapshot(
            id: 1, chat: chat, statusText: streaming ? "正在输出…" : "",
            queueItems: [], agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: nil),
            questions: [], home: nil, checkout: nil, busy: streaming
        )
        snapshot = ClientSnapshot(
            version: version, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil,
            organized: Organized(chats: [], projects: [], archived: []),
            notices: [], models: [],
            defaults: Defaults(model: nil, thinkingLevel: nil),
            conversation: conv
        )
        replyStreams.sync(chat: chat)
    }
}
