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

    /// What an optimistic send cleared, kept briefly so a command-class
    /// refusal (attachments come back as notices) can restore it.
    struct PendingAttachmentSend {
        let text: String
        let images: [MessageImage]
        let chips: SkillChips
        let files: FileAttachmentTray
        let noticesBefore: UInt64
        let expiresAt: Date
    }

    /// What the root presents as a sheet — one slot, so a deep link or a
    /// scan arriving while another sheet is up waits for it to close
    /// instead of being dropped by SwiftUI.
    enum Modal: Identifiable {
        /// Settings over a page that has no list to push it from (the
        /// connecting and failure pages).
        case settings
        case account
        case pairingCode
        case scanner
        case confirm(PendingPairing)

        var id: String {
            switch self {
            case .settings: "settings"
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
    /// The host or pairing identity the connection is for. One value so a
    /// completed handshake consumes the one-time link before Retry reads it.
    private(set) var pairing = PairingAttempt()
    /// The host the session is this device on — a stored host, or the one
    /// a pairing just made (even if the keychain failed to keep it); nil
    /// until a pairing's handshake completes.
    var sessionHost: HostRecord? { pairing.host }
    var currentHostKey: String? { sessionHost?.hostKey }
    /// The link the session is pairing with, until its handshake spends the
    /// one-time code (then retrying must reconnect, not pair again).
    var pairingLink: String? { pairing.link }
    /// The account link a server-vouched pairing must carry into the saved
    /// host — kept beside the link so Retry doesn't lose it.
    var pairingAccount: AccountLink? { pairing.account }
    /// Where that link goes — names the host while pairing.
    var pairingTarget: PairingTarget? { pairing.target }
    /// The host the device was on before the latest pairing, so a pairing
    /// that fails after its handshake (which already made the new host the
    /// launch one) still offers the way back. Cleared once a session is up.
    private(set) var hostBeforePairing: String?
    /// Bumped by each completed pairing handshake — the success haptic's
    /// trigger, which an ordinary reconnect never fires.
    private(set) var pairings = 0
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
    /// Unsent composer text per conversation — kept across navigation,
    /// dropped with the session (a new host has other conversations).
    var drafts: [UInt64: String] = [:]
    /// The `$` menu picks bound in each draft (ADR-0028), read through
    /// `chips(for:)`, which follows them onto the draft's current text.
    var skillChips: [UInt64: SkillChips] = [:]
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
    /// Host-stored file uploads per conversation (issue #321). Kept beside
    /// the images so a switch mid-upload neither loses nor redirects one.
    var fileTrays: [UInt64: FileAttachmentTray] = [:]
    /// Sends with attachments whose cleared draft may still need restoring.
    var pendingAttachmentSends: [UInt64: PendingAttachmentSend] = [:]
    /// The queued-input Edit flow: the copy read before withdrawing, its
    /// request phase, and the composer lock. Memory only; a host switch
    /// drops it (an unresolved copy is retried after a same-host reconnect).
    var queuedEdit = QueuedEdit()
    /// Conversations whose queued copy is resolving ref images before any
    /// withdraw starts. The composer stays locked meanwhile so a ref copy
    /// cannot land over new typing.
    var queuedEditPreparing: Set<UInt64> = []
    /// Queued rows whose withdraw/steer request is in flight. An Edit's row
    /// stays here until its outcome is known.
    var queuePending: Set<UInt64> = []
    /// Bumped per conversation when an Edit hands content back, so the open
    /// composer can focus after the refill.
    var queuedEditFocus: [UInt64: UInt64] = [:]
    /// Local toast ids descend from the top so they never collide with the
    /// core's increasing notice ids.
    var localToastID: UInt64 = .max
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
    /// The consumer of the current session's update stream. It keeps
    /// draining after a timeout closes the session, so a just-queued
    /// paired update lands before the failure page.
    private var connectAttempt: ConnectAttempt?
    /// Bumped when the session is replaced or stopped — a late update from
    /// the old session must not land on the new one.
    var sessionGeneration: UInt64 = 0
    /// The `$` skill listings for this host session, one entry per scope
    /// (issue #143). Reset when the host changes.
    var skillCache = SkillListCache()
    /// The `/` command listings for this host session, one entry per
    /// conversation (issue #254). Reset when the host changes.
    var commandCache = CommandListCache()
    /// The first-connect deadline for the current attempt, nil once it is
    /// ready or has failed.
    private var connectWatchdog: ConnectWatchdog?
    /// Scene state for a session that starts while the app is backgrounded
    /// (an account pairing response can land then). Its first-connect
    /// window starts paused and gets a full 15 seconds on foreground.
    private var isInBackground = UIApplication.shared.applicationState == .background
    let store = KeychainHostStore()
    /// Content-addressed image bytes for ref-mode conversations (ADR-0027).
    /// UI-owned: fetches never enter the session's ordered state.
    let images = ImageStore()
    /// Bumped when the shown conversation's ref subscription becomes fresh,
    /// so a failed ref fetch retries on reconnect (AgentChatKit's inline
    /// image epoch). A connected hello alone is not enough: the host may not
    /// have rebuilt the conversation subscription yet.
    var imageEpoch: UInt64 = 0
    private var lastConversationFreshEpoch: UInt64 = 0
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
    var accountPairingGeneration: UInt64 = 0
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

    /// Dev-only launch channels, compiled out of Release. The logic lives in
    /// `AppModel+DevLaunch.swift`; the few members here are internal because a
    /// Swift extension in another file cannot reach `private` state.
    #if DEBUG
    /// Set by `-openConversation` / `PINOMAD_OPEN` — pushed once connected.
    var pendingOpen: UInt64?
    /// Retries an injected pairing link while the phase is a failure.
    var pairRetryTask: Task<Void, Never>?
    /// A demo's answer to `changes()` — a demo has no session to ask.
    var devChanges: ConversationChanges?
    /// A file to attach after pairing, and whether to create the draft once
    /// it finishes uploading — the simulator end-to-end seam.
    var pendingAttachFile: String?
    var pendingAttachSend = false
    /// The agent demo opens the conversation's model sheet once the
    /// composer is on screen, so a screenshot can show it without a host.
    var devShowsModelSheet = false

    /// Publish a demo snapshot through the slot the session normally fills;
    /// the setter itself stays file-private.
    func publishDevSnapshot(_ snapshot: ClientSnapshot) { self.snapshot = snapshot }

    /// A demo host list stands in for the keychain's; switching and
    /// forgetting must then neither write the keychain nor dial anything.
    var devHostsInjected = false

    /// Stand a demo host list in for the keychain's, with `stored.active` as
    /// the session's host. Nothing is written to the keychain.
    func useDevHosts(_ stored: StoredHosts) {
        devHostsInjected = true
        hosts = stored
        if let active = stored.active { pairing.connect(active) }
    }
    #endif

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
        // Scripted launch channels exist only in Debug builds (see
        // `AppModel+DevLaunch.swift`). One that takes over startup returns
        // here; Release skips straight to the normal stored-host path.
        #if DEBUG
        if applyDevLaunch() { return }
        #endif
        loadAccount()
        connectActive()
    }

    func didEnterForeground() {
        isInBackground = false
        connectWatchdog?.resume()
        session?.notifyForeground()
        Task { [weak self] in
            await self?.push.refreshAuthorization()
            self?.syncPushToken()
        }
    }
    func didEnterBackground() {
        isInBackground = true
        connectWatchdog?.pause()
        session?.notifyBackground()
    }

    /// Show and talk to a conversation — command-class, so a refused
    /// switch surfaces as a snapshot notice, not a thrown error.
    func openConversation(_ id: UInt64) {
        Task { [weak self] in
            _ = try? await self?.session?.invoke(.switchConversation(id: id))
        }
    }

    /// Start a session pairing with `link` — replaces whatever session ran.
    /// `account` is set only for a server-vouched pairing; it rides into the
    /// saved host record.
    @discardableResult
    func pair(link: String, account: AccountLink? = nil) -> Bool {
        // A QR/pasted pairing starts a new target; an in-flight account ask
        // for another host must not land after it.
        if account == nil { invalidateAccountPairing() }
        do {
            let previous = currentHostKey ?? hosts.active?.hostKey
            let session = try PinomadSession.pair(
                link: link,
                deviceName: DeviceModelName.currentDisplayName(fallback: UIDevice.current.model),
                account: account)
            adopt(session, sameHost: false)
            hostBeforePairing = hostBeforePairing ?? previous
            pairing.pair(
                link: link, account: account,
                target: PinomadCore.pairingTarget(link: link))
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
        invalidateAccountPairing()
        do {
            let session = try PinomadSession.connect(host: host)
            adopt(session, sameHost: host.hostKey == currentHostKey)
            pairing.connect(host)
        } catch {
            fail(.unreachable(describe(error)))
        }
    }

    /// Re-read the keychain and connect to the launch host, or wait for a
    /// link when there is none.
    func connectActive() {
        invalidateAccountPairing()
        do {
            hosts = try store.load()
            hostsLoaded = true
        } catch {
            closeSession()
            fail(.unreachable("Couldn't read the saved pairings: \(describe(error))"))
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
        connectWatchdog?.cancel()
        connectWatchdog = nil
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
        stopSession()
        pairing.clear()
    }

    /// Drop the live session but leave the host/pairing identity in place —
    /// the timeout failure page still needs the target for Retry, Cancel
    /// and "back to the previous host".
    private func stopSession() {
        sessionGeneration &+= 1
        connectWatchdog?.cancel()
        connectWatchdog = nil
        connectAttempt?.stop()
        connectAttempt = nil
        session?.close()
        session = nil
        snapshot = nil
        push.currentConnectedHostKey = nil
        lastSnapshotConnected = false
        lastConversationFreshEpoch = 0
    }

    /// A fresh 15-second window for this attempt. The callback carries the
    /// session generation so a timer that already woke up cannot stop a
    /// session that replaced it.
    private func armConnectWatchdog() {
        connectWatchdog?.cancel()
        let generation = sessionGeneration
        let watchdog = ConnectWatchdog { [weak self] in
            Task { @MainActor in
                guard let self,
                      self.sessionGeneration == generation,
                      self.phase == .connecting,
                      let attempt = self.connectAttempt
                else { return }
                self.connectWatchdog?.cancel()
                self.connectWatchdog = nil
                // Close, then keep draining until the session's update
                // stream ends; the failure page waits for that finish.
                attempt.timeout(address: self.connectAddress)
            }
        }
        connectWatchdog = watchdog
        watchdog.begin(paused: isInBackground)
    }

    /// The session finished draining after a timeout with no ready. The
    /// paired update (if any) has already been applied by now.
    private func finishTimedOut(address: String?) {
        guard phase == .connecting else { return }
        stopSession()
        fail(.timedOut(address: address))
    }

    /// Take over `session`. `sameHost` is a rebuilt session for the host
    /// already on screen (Retry, Reconnect): the reader's unsent work and
    /// place stay. Anything else is another host, whose conversations
    /// those drafts and pages don't belong to.
    private func adopt(_ session: PinomadSession, sameHost: Bool) {
        sessionGeneration &+= 1
        let generation = sessionGeneration
        connectAttempt?.stop()
        connectAttempt = nil
        self.session?.close()
        self.session = session
        snapshot = nil
        lastError = ""
        pushError = nil
        push.currentConnectedHostKey = nil
        lastSnapshotConnected = false
        lastConversationFreshEpoch = 0
        pendingAttachmentSends = [:]
        replyStreams.sync(chat: nil)
        toasts = []
        noticeFeed = NoticeFeed()
        if sameHost {
            if case .conversation(let id) = navPath.last { reopenAfterReady = id }
        } else {
            navPath = []
            reopenAfterReady = nil
            skillCache.reset()
            commandCache.reset()
            drafts = [:]
            skillChips = [:]
            questionDrafts = [:]
            trays = [:]
            fileTrays = [:]
            pendingAttachmentSends = [:]
            queuedEdit.reset()
            queuedEditPreparing.removeAll()
            queuePending.removeAll()
            queuedEditFocus = [:]
            viewing = nil
            draftHome = .chat
            draftCheckout = .worktree
            draftAgent.reset()
        }
        phase = .connecting
        let attempt = ConnectAttempt(
            updates: session.updates,
            close: { session.close() },
            apply: { [weak self] update in
                guard let self, self.sessionGeneration == generation else { return }
                self.apply(update)
            },
            onTimeout: { [weak self] address in
                guard let self,
                      self.sessionGeneration == generation,
                      self.phase == .connecting
                else { return }
                self.finishTimedOut(address: address)
            })
        connectAttempt = attempt
        attempt.start()
        armConnectWatchdog()
    }

    /// A submit with attachments is command-class, so a refused reference
    /// (expired / missing / still uploading at the host) only arrives as a
    /// notice. Put the cleared draft back unless the reader moved on.
    private func restoreRejectedAttachmentSend(after notices: [Notice]) {
        guard !pendingAttachmentSends.isEmpty else { return }
        let now = Date.now
        for key in Array(pendingAttachmentSends.keys) {
            guard let pending = pendingAttachmentSends[key] else { continue }
            if now >= pending.expiresAt {
                pendingAttachmentSends[key] = nil
                continue
            }
            guard let rejection = notices.first(where: {
                $0.id > pending.noticesBefore && AttachmentNotice.isRejection($0.message)
            }) else { continue }
            pendingAttachmentSends[key] = nil
            guard (drafts[key] ?? "").isEmpty, trays[key]?.isEmpty ?? true,
                  fileTrays[key] == nil else { continue }
            drafts[key] = pending.text
            skillChips[key] = pending.chips
            if !pending.images.isEmpty {
                var tray = AttachmentTray()
                if let claim = tray.reserve(pending.images.count, accepts: true) {
                    tray.fulfil(claim, with: pending.images)
                }
                trays[key] = tray
            }
            if !pending.files.isEmpty { fileTrays[key] = pending.files }
            lastError = rejection.message
        }
    }

    private func apply(_ update: SessionUpdate) {
        switch update {
        case .ready(let outcome):
            // The first ready ends the first-connect window whatever it
            // says — a success, or a failure page of its own.
            connectWatchdog?.cancel()
            connectWatchdog = nil
            // A revoked device can be refused before the first snapshot; the
            // account list still needs the marker.
            if outcome == .unauthorized, let host = revokedHost {
                markAccountRejected(host)
            }
            if let failure = ConnectFailure(outcome: outcome, pairing: pairingLink != nil) {
                fail(failure)
                return
            }
            phase = .connected
            hostBeforePairing = nil
            push.currentConnectedHostKey = sessionHost?.hostKey
            #if DEBUG
            consumeDevOpenRequest()
            consumeDevAttachRequest()
            #endif
            if let id = reopenAfterReady {
                reopenAfterReady = nil
                openConversation(id)
            }
            advancePushTarget()
        case .paired(let host, let saveError):
            // The handshake spent the link's code and (normally) made this
            // the launch host — the session is this host's device now,
            // whatever the first view turns out to say.
            pairing.paired(host)
            pairings += 1
            accountRejectedHostKeys.remove(host.hostKey)
            reloadHosts()
            accountRefreshAfterPairing()
            advancePushTarget()
            if let saveError {
                lastError = "Couldn't save this host (\(saveError)). After a restart the app returns to the previous host, and you'll need to pair again to use this one."
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
            let freshEpoch = snapshot.conversation?.freshEpoch ?? 0
            if freshEpoch > lastConversationFreshEpoch { imageEpoch &+= 1 }
            lastConversationFreshEpoch = freshEpoch
            if let hostKey = sessionHost?.hostKey {
                cacheHostName(snapshot.hostName, for: hostKey)
            }
            let freshNotices = noticeFeed.fresh(snapshot.notices)
            restoreRejectedAttachmentSend(after: freshNotices)
            // A failure page explains itself; the core's notice for the
            // same thing (e.g. the 4401) would only repeat it in English.
            for notice in freshNotices where phase == .connected { show(notice) }
            let connectedNow = snapshot.connection == .connected && !snapshot.unauthorized
            push.currentConnectedHostKey = connectedNow ? sessionHost?.hostKey : nil
            if connectedNow && !lastSnapshotConnected { syncPushToken() }
            if connectedNow {
                // Retry on every connected view, not just the disconnect
                // edge: ViewChanged coalescing can hide the offline snapshot.
                // The state machine refuses a duplicate while one is in
                // flight, so this is cheap and idempotent.
                retryQueuedEditIfNeeded()
            }
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

}
