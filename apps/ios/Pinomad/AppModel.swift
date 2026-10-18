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
        case account
        case pairingCode
        case scanner
        case confirm(PendingPairing)

        var id: String {
            switch self {
            case .hosts: "hosts"
            case .account: "account"
            case .pairingCode: "pairingCode"
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
    /// The host the session is this device on — a stored host, or the one
    /// a pairing just made (even if the keychain failed to keep it); nil
    /// until a pairing's handshake completes.
    private(set) var sessionHost: HostRecord?
    var currentHostKey: String? { sessionHost?.hostKey }
    /// The link the session is pairing with, until its handshake spends the
    /// one-time code (then retrying must reconnect, not pair again).
    private(set) var pairingLink: String?
    /// Where that link goes — names the host while pairing.
    private(set) var pairingTarget: PairingTarget?
    /// The host the device was on before the latest pairing, so a pairing
    /// that fails after its handshake (which already made the new host the
    /// launch one) still offers the way back. Cleared once a session is up.
    private(set) var hostBeforePairing: String?
    /// The conversation on screen when the same host's session was rebuilt
    /// — the new session has to be told to show it again once up.
    private var reopenAfterReady: UInt64?
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
    /// The draft's remembered pick, chosen agent and per-side overrides
    /// (ADR-0023). Kept across navigation, reset when the host changes.
    var draftAgent = AgentDraftPick()
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
    // Account state (ADR-0022). The token lives in the keychain and the
    // in-memory record only; everything else here is view state.
    let accountStore = KeychainAccountStore()
    let accountTransport: any AccountTransport = URLSessionAccountTransport()
    var accountRecord: AccountRecord?
    var accountRows: [AccountHostRow] = []
    var accountHostsError: String?
    var accountError: String?
    var accountNotice: String?
    var accountSignOutWarning: String?
    var accountBusy = false
    var accountRefreshing = false
    var accountRefreshPending = false
    var accountPairingHostId: String?
    var accountRejectedHostKeys: Set<String> = []
    /// Push switches, permission, APNs token, and the system callbacks.
    let push = PushCenter.shared
    /// The host's reason the last token change failed, shown by the switch.
    var pushError: String?
    /// A forgotten host whose push registration could not be cleared.
    var pushForgetWarning: String?
    var pendingPush: PushTarget?
    /// Set once the keychain answered — a cold-start tap must not be
    /// dropped as "unknown host" before the stored hosts are read.
    var hostsLoaded = false
    var pushSyncInFlight = false
    var pushSyncPending = false
    /// Hosts whose pairing is being removed; no new token change may be
    /// queued for them while the clearing request is in flight.
    var forgettingHosts: Set<String> = []
    var lastSnapshotConnected = false
    private let monitor = NetworkMonitor()
    /// Marks each snapshot landing on the main actor — paired with the
    /// session's `bytes`/`publish` events for the byte-to-UI latency.
    private let signposter = OSSignposter(subsystem: "build.kieran.pinomad", category: "delivery")

    func start() {
        push.onTarget = { [weak self] target in self?.receivePushTarget(target) }
        push.onToken = { [weak self] in self?.syncPushToken() }
        if let target = push.takePendingTarget() { receivePushTarget(target) }
        Task { [weak self] in
            await self?.push.bootstrap()
            self?.syncPushToken()
        }
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
        loadAccount()
        connectActive()
        if !injected.isEmpty { offerPairing(injected) }
    }

    func didEnterForeground() {
        session?.notifyForeground()
        Task { [weak self] in
            await self?.push.refreshAuthorization()
            self?.syncPushToken()
        }
    }
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
    /// `account` is set only for a server-vouched pairing; it rides into the
    /// saved host record.
    @discardableResult
    func pair(link: String, account: AccountLink? = nil) -> Bool {
        do {
            let previous = currentHostKey ?? hosts.active?.hostKey
            let session = try PinomadSession.pair(
                link: link, deviceName: UIDevice.current.name, account: account)
            adopt(session, sameHost: false)
            hostBeforePairing = hostBeforePairing ?? previous
            sessionHost = nil
            pairingLink = link
            pairingTarget = PinomadCore.pairingTarget(link: link)
            return true
        } catch {
            // Links reach here through `offerPairing`, which already parsed
            // them — this is the core refusing to build the session.
            fail(.unreachable(describe(error)))
            return false
        }
    }

    /// Start a session for a stored host.
    func connect(_ host: HostRecord) {
        do {
            let session = try PinomadSession.connect(host: host)
            adopt(session, sameHost: host.hostKey == currentHostKey)
            sessionHost = host
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
            hostsLoaded = true
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
        advancePushTarget()
    }

    /// Refresh `hosts` from the keychain; a failed read keeps the last
    /// good list (connecting reports it, see `connectActive`).
    func reloadHosts() {
        if let stored = try? store.load() {
            hosts = stored
            hostsLoaded = true
        }
    }

    func fail(_ failure: ConnectFailure) {
        phase = .failed(failure)
        push.currentConnectedHostKey = nil
        lastSnapshotConnected = false
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
        sessionHost = nil
        pairingLink = nil
        pairingTarget = nil
        push.currentConnectedHostKey = nil
        lastSnapshotConnected = false
    }

    /// Take over `session`. `sameHost` is a rebuilt session for the host
    /// already on screen (Retry, Reconnect): the reader's unsent work and
    /// place stay. Anything else is another host, whose conversations
    /// those drafts and pages don't belong to.
    private func adopt(_ session: PinomadSession, sameHost: Bool) {
        self.session?.close()
        self.session = session
        snapshot = nil
        lastError = ""
        pushError = nil
        push.currentConnectedHostKey = nil
        lastSnapshotConnected = false
        replyStreams.sync(chat: nil)
        toasts = []
        noticeFeed = NoticeFeed()
        if sameHost {
            if case .conversation(let id) = navPath.last { reopenAfterReady = id }
        } else {
            navPath = []
            reopenAfterReady = nil
            drafts = [:]
            questionDrafts = [:]
            trays = [:]
            viewing = nil
            draftHome = .chat
            draftCheckout = .worktree
            draftAgent.reset()
        }
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
            phase = .connected
            hostBeforePairing = nil
            push.currentConnectedHostKey = sessionHost?.hostKey
            if let id = pendingOpen {
                pendingOpen = nil
                navPath = [.conversation(id)]
            }
            if let id = reopenAfterReady {
                reopenAfterReady = nil
                openConversation(id)
            }
            advancePushTarget()
        case .paired(let host, let saveError):
            // The handshake spent the link's code and (normally) made this
            // the launch host — the session is this host's device now,
            // whatever the first view turns out to say.
            sessionHost = host
            pairingLink = nil
            reloadHosts()
            if saveError == nil, let link = host.account {
                pruneAccountPairing(link: link, keepingHostKey: host.hostKey)
            }
            accountRefreshAfterPairing()
            advancePushTarget()
            if let saveError {
                lastError = "没能记住这台宿主（\(saveError)）：重启 App 后会回到之前的宿主，要再用它得重新配对。"
            }
        case .snapshot(let snapshot):
            // Terminal after the first view: revoked (4401) or a hello
            // with another protocol major.
            if let failure = ConnectFailure(snapshot: snapshot) {
                fail(failure)
            }
            if snapshot.unauthorized, let host = revokedHost {
                markAccountRejected(host)
            }
            self.snapshot = snapshot
            // A failure page explains itself; the core's notice for the
            // same thing (e.g. the 4401) would only repeat it in English.
            for notice in noticeFeed.fresh(snapshot.notices) where phase == .connected { show(notice) }
            let connectedNow = snapshot.connection == .connected && !snapshot.unauthorized
            push.currentConnectedHostKey = connectedNow ? sessionHost?.hostKey : nil
            if connectedNow && !lastSnapshotConnected { syncPushToken() }
            lastSnapshotConnected = connectedNow
            advancePushTarget()
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
            agents: nil,
            conversation: conv
        )
        replyStreams.sync(chat: chat)
    }
}
