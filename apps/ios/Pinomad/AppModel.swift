import Foundation
import OSLog
import AgentChatKit
import PinomadChat
import PinomadCore
import UIKit

/// The app's composition root: every paired host's runtime, the one focused
/// host/conversation, pairing and account flow, and the state the screens
/// read through the focused runtime (ADR-0035). Connection state itself lives
/// in `HostRuntime`, one per host.
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
    private var globalFailure: ConnectFailure?
    /// Every paired host and which one opens on launch, as last read from
    /// the keychain.
    private(set) var hosts = StoredHosts()
    /// The stored order plus the one focus. Kept beside the runtime objects
    /// so the ordering and release rules are testable without a session.
    private(set) var runtimeTable = HostRuntimeTable(hostKeys: [])
    /// One runtime per paired host, keyed by hostKey.
    private(set) var runtimes: [String: HostRuntime] = [:]
    /// A pairing handshake that has not named its host yet. Once it does, the
    /// same runtime joins `runtimes`.
    var pairingRuntime: HostRuntime?
    /// Whether the pairing runtime is what the screen shows. An account
    /// registration pairs in the background and never steals focus.
    private var pairingOwnsFocus = false
    /// Hosts whose pairing is live but whose keychain save failed. They stay
    /// in the table until the next successful save or a forget.
    var unsavedHostKeys: Set<String> = []
    /// Account registrations that registered on the host but failed to save
    /// locally, by hostId. The next refresh retries only the save (ADR-0035 §5).
    var unsavedAccountHosts: [String: HostRecord] = [:]

    /// A paired handshake whose keychain write failed. Kept separately from
    /// `lastError` so the failure page can show it beside the connection
    /// failure instead of losing it with the list page.
    var pairingSaveWarning: String? { focusedRuntime?.pairingWarning.message }
    /// The RTC coordinator's status for the focused session.
    var rtcStatus: RtcDiagnostics? { focusedRuntime?.rtcStatus }
    /// When `rtcStatus` was read, so the page can count a cooldown down
    /// without asking the core on every tick.
    var rtcStatusAt: Date { focusedRuntime?.rtcStatusAt ?? .distantPast }
    /// The host or pairing identity the connection is for. One value so a
    /// completed handshake consumes the one-time link before Retry reads it.
    private(set) var pairing = PairingAttempt()
    /// The host the focused session is this device on — a stored host, or the
    /// one a pairing just made (even if the keychain failed to keep it).
    var sessionHost: HostRecord? {
        if pairingOwnsFocus { return pairing.host }
        return focusedRuntime?.host
    }
    var currentHostKey: String? {
        #if DEBUG
        if devHostsInjected { return developmentRuntime?.hostKey ?? runtimeTable.focus?.hostKey }
        #endif
        if pairingOwnsFocus, pairing.host == nil { return nil }
        return runtimeTable.focus?.hostKey ?? sessionHost?.hostKey
    }
    /// The link the session is pairing with, until its handshake spends the
    /// one-time code (then retrying must reconnect, not pair again).
    var pairingLink: String? { pairingOwnsFocus ? pairing.link : nil }
    /// The account link a server-vouched pairing must carry into the saved
    /// host — kept beside the link so Retry doesn't lose it.
    var pairingAccount: AccountLink? { pairingOwnsFocus ? pairing.account : nil }
    /// Where that link goes — names the host while pairing.
    var pairingTarget: PairingTarget? { pairingOwnsFocus ? pairing.target : nil }
    /// The host the device was on before the latest pairing, so a pairing
    /// that fails after its handshake still offers the way back.
    private(set) var hostBeforePairing: String?
    /// Bumped by each completed pairing handshake — the success haptic's
    /// trigger, which an ordinary reconnect never fires.
    private(set) var pairings = 0
    var modal: Modal?
    private var nextModal: Modal?
    /// The newest published view for the focused host — the list and the
    /// open conversation both read straight off it.
    var snapshot: ClientSnapshot? { focusedRuntime?.snapshot }
    /// "Connecting…" in the bar for the focused host.
    var showsReconnecting: Bool { focusedRuntime?.showsReconnecting ?? false }
    /// NavigationStack path.
    var navPath: [Route] = []
    /// Live answer streams, one set per host. Reading through the focused
    /// runtime means a non-focused host's snapshot can never feed them.
    var replyStreams: ReplyStreams { focusedRuntime?.replyStreams ?? emptyReplyStreams }
    private let emptyReplyStreams = ReplyStreams()
    /// Unsent composer text per conversation on the focused host.
    var drafts: [UInt64: String] {
        get { focusedRuntime?.drafts ?? [:] }
        set { focusedRuntime?.drafts = newValue }
    }
    var skillChips: [UInt64: SkillChips] {
        get { focusedRuntime?.skillChips ?? [:] }
        set { focusedRuntime?.skillChips = newValue }
    }
    /// The new-conversation draft's host-local state.
    var draftHome: NewConversationHome {
        get { focusedRuntime?.draftHome ?? .chat }
        set { focusedRuntime?.draftHome = newValue }
    }
    var draftCheckout: ConversationCheckout {
        get { focusedRuntime?.draftCheckout ?? .worktree }
        set { focusedRuntime?.draftCheckout = newValue }
    }
    var draftAgent: AgentDraftPick {
        get { focusedRuntime?.draftAgent ?? AgentDraftPick() }
        set { focusedRuntime?.draftAgent = newValue }
    }
    var creating: Bool {
        get { focusedRuntime?.creating ?? false }
        set { focusedRuntime?.creating = newValue }
    }
    /// Staged images per conversation, beside its draft text.
    var trays: [UInt64: AttachmentTray] {
        get { focusedRuntime?.trays ?? [:] }
        set { focusedRuntime?.trays = newValue }
    }
    /// Host-stored file uploads per conversation (issue #321).
    var fileTrays: [UInt64: FileAttachmentTray] {
        get { focusedRuntime?.fileTrays ?? [:] }
        set { focusedRuntime?.fileTrays = newValue }
    }
    var fileReads: [UInt64: Set<UUID>] {
        get { focusedRuntime?.fileReads ?? [:] }
        set { focusedRuntime?.fileReads = newValue }
    }
    var queuedEdit: QueuedEdit {
        get { focusedRuntime?.queuedEdit ?? QueuedEdit() }
        set { focusedRuntime?.queuedEdit = newValue }
    }
    var queuedEditPreparing: Set<UInt64> {
        get { focusedRuntime?.queuedEditPreparing ?? [] }
        set { focusedRuntime?.queuedEditPreparing = newValue }
    }
    var queuePending: Set<UInt64> {
        get { focusedRuntime?.queuePending ?? [] }
        set { focusedRuntime?.queuePending = newValue }
    }
    var queuedEditFocus: [UInt64: UInt64] {
        get { focusedRuntime?.queuedEditFocus ?? [:] }
        set { focusedRuntime?.queuedEditFocus = newValue }
    }
    var takingBack: UInt64? {
        get { focusedRuntime?.takingBack }
        set { focusedRuntime?.takingBack = newValue }
    }
    var submissionPending: Set<String> {
        get { focusedRuntime?.submissionPending ?? [] }
        set { focusedRuntime?.submissionPending = newValue }
    }
    var sentFileDetails: [String: [UserAttachment]] {
        get { focusedRuntime?.sentFileDetails ?? [:] }
        set { focusedRuntime?.sentFileDetails = newValue }
    }
    /// The message image shown full screen, if any.
    var viewing: MessageImage? {
        get { focusedRuntime?.viewing }
        set { focusedRuntime?.viewing = newValue }
    }
    var questionDrafts: [String: QuestionDraft] {
        get { focusedRuntime?.questionDrafts ?? [:] }
        set { focusedRuntime?.questionDrafts = newValue }
    }
    /// Bumped when the reader acts at the transcript's end.
    var transcriptPin: Int {
        get { focusedRuntime?.transcriptPin ?? 0 }
        set { focusedRuntime?.transcriptPin = newValue }
    }
    /// Which conversation page's open settled without showing it.
    var opening: ConversationOpening {
        get { focusedRuntime?.opening ?? ConversationOpening() }
        set { focusedRuntime?.opening = newValue }
    }
    /// A sheet is up and shows the toasts itself.
    var sheetShowsToasts = false
    /// Notices currently shown as toasts, newest last. They are collected
    /// from every host, so a failure on a background host is still visible;
    /// with more than one host paired the message names its source.
    var toasts: [Notice] = []
    private var nextToastID: UInt64 = .max
    var lastError: String {
        get { focusedRuntime?.lastError ?? globalError }
        set {
            if let runtime = focusedRuntime { runtime.lastError = newValue }
            else { globalError = newValue }
        }
    }
    private var globalError = ""

    /// The consumer of the focused session's update stream. Kept for the dev
    /// seams and for the account/queue code that only needs the focused host.
    var session: PinomadSession? { focusedRuntime?.session }
    /// The `$` skill listings for the focused host.
    var skillCache: SkillListCache {
        get { focusedRuntime?.skillCache ?? SkillListCache() }
        set { focusedRuntime?.skillCache = newValue }
    }
    /// The `/` command listings for the focused host.
    var commandCache: CommandListCache {
        get { focusedRuntime?.commandCache ?? CommandListCache() }
        set { focusedRuntime?.commandCache = newValue }
    }
    /// Scene state for a session that starts while the app is backgrounded.
    private var isInBackground = UIApplication.shared.applicationState == .background
    let store = KeychainHostStore()
    /// Content-addressed image bytes for ref-mode conversations (ADR-0027).
    let images = ImageStore()
    /// Bumped when the focused conversation's ref subscription becomes fresh.
    var imageEpoch: UInt64 { focusedRuntime?.imageEpoch ?? 0 }
    // Account state (ADR-0022).
    let accountStore = KeychainAccountStore()
    let accountTransport: any AccountTransport = URLSessionAccountTransport()
    let declinedAccountHosts = DeclinedAccountHosts()
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
    /// In-flight automatic registrations, by hostId, so a refresh re-entry
    /// cannot start a second handshake for the same account host.
    var accountRegistrationInFlight: Set<String> = []
    /// Auto-registration runtimes by hostId, so sign-out or a forget can
    /// really abandon a handshake that already started.
    var automaticPairingRuntimes: [String: HostRuntime] = [:]
    var accountRejectedHostKeys: Set<String> = []
    /// Push switches, permission, APNs token, and the system callbacks.
    let push = PushCenter.shared
    var pushError: String?
    var pushForgetWarning: String?
    var pendingPush: PushTarget?
    /// Set once the keychain answered — a cold-start tap must not be
    /// dropped as "unknown host" before the stored hosts are read.
    var hostsLoaded = false
    /// Push registration is serialized per host: one request in flight and at
    /// most one queued behind it.
    var pushSyncInFlight: Set<String> = []
    var pushSyncPending: Set<String> = []
    var forgettingHosts: Set<String> = []
    let monitor = NetworkMonitor()
    /// Marks each focused snapshot landing on the main actor.
    private let signposter = OSSignposter(subsystem: "build.kieran.pinomad", category: "delivery")

    /// Dev-only launch channels, compiled out of Release.
    #if DEBUG
    var pendingOpen: UInt64?
    var pairRetryTask: Task<Void, Never>?
    var devChanges: ConversationChanges?
    var pendingAttachFile: String?
    var pendingAttachSend = false
    var pendingPromptFile: String?
    var openHostDetailAfterReady = false
    var devShowsModelSheet = false
    var devHostsInjected = false
    private var developmentRuntime: HostRuntime?

    /// Publish a demo snapshot through the slot the focused runtime fills.
    func publishDevSnapshot(_ snapshot: ClientSnapshot) {
        if developmentRuntime == nil {
            let host = sessionHost
            let runtime = HostRuntime(
                hostKey: host?.hostKey ?? "demo", host: host, isPairing: false)
            developmentRuntime = runtime
            runtime.onToast = { [weak self] runtime, notice in
                self?.presentToast(runtime, notice: notice)
            }
            if runtimeTable.hostKeys.isEmpty, let key = runtime.hostKey {
                runtimeTable = HostRuntimeTable(hostKeys: [key], rememberedHostKey: key)
            }
        }
        developmentRuntime?.publishDevelopmentSnapshot(snapshot)
        phase = .connected
    }

    /// A demo host list stands in for the keychain's; switching and
    /// forgetting must then neither write the keychain nor dial anything.
    func useDevHosts(_ stored: StoredHosts) {
        devHostsInjected = true
        hosts = stored
        runtimeTable = HostRuntimeTable(
            hostKeys: stored.hosts.map(\.hostKey), rememberedHostKey: stored.activeHostKey)
        if let active = stored.active {
            pairing.connect(active)
            let runtime = HostRuntime(hostKey: active.hostKey, host: active, isPairing: false)
            runtime.onToast = { [weak self] runtime, notice in
                self?.presentToast(runtime, notice: notice)
            }
            developmentRuntime = runtime
        }
    }
    #endif

    /// A pairing runtime that has not joined the table yet — a paired one is
    /// already in `runtimes` and must not receive the same event twice.
    private var pairingRuntimeOutsideTable: HostRuntime? {
        guard let pairingRuntime else { return nil }
        guard let hostKey = pairingRuntime.hostKey else { return pairingRuntime }
        return runtimes[hostKey] === pairingRuntime ? nil : pairingRuntime
    }

    /// The runtime the screen reads, or a pairing handshake that owns it.
    var focusedRuntime: HostRuntime? {
        if pairingOwnsFocus, let pairingRuntime { return pairingRuntime }
        #if DEBUG
        if devHostsInjected { return developmentRuntime }
        #endif
        if let key = runtimeTable.focus?.hostKey, let runtime = runtimes[key] {
            return runtime
        }
        #if DEBUG
        return developmentRuntime
        #else
        return nil
        #endif
    }

    func start() {
        push.onTarget = { [weak self] target in self?.receivePushTarget(target) }
        push.onToken = { [weak self] in self?.syncPushToken() }
        if let target = push.takePendingTarget() { receivePushTarget(target) }
        Task { [weak self] in
            await self?.push.bootstrap()
            self?.syncPushToken()
        }
        // The monitor runs for the app's lifetime; every host's session gets
        // each real path change.
        monitor.start { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                for runtime in self.runtimes.values { runtime.networkChanged() }
                for runtime in self.automaticPairingRuntimes.values
                where runtime !== self.pairingRuntime {
                    runtime.networkChanged()
                }
                self.pairingRuntimeOutsideTable?.networkChanged()
            }
        }
        #if DEBUG
        if applyDevLaunch() { return }
        #endif
        loadAccount()
        if accountSession != nil {
            Task { [weak self] in await self?.accountRefreshHosts() }
        }
        connectActive()
    }

    func didEnterForeground() {
        // Only a real return: Control Center or a banner goes through
        // .inactive and back without suspending anything.
        isInBackground = false
        for runtime in runtimes.values { runtime.foregrounded() }
        for runtime in automaticPairingRuntimes.values where runtime !== pairingRuntime {
            runtime.foregrounded()
        }
        pairingRuntimeOutsideTable?.foregrounded()
        Task { [weak self] in
            await self?.push.refreshAuthorization()
            self?.syncPushToken()
        }
        if accountSession != nil {
            Task { [weak self] in await self?.accountRefreshHosts() }
        }
    }

    func didEnterBackground() {
        isInBackground = true
        for runtime in runtimes.values { runtime.backgrounded() }
        for runtime in automaticPairingRuntimes.values where runtime !== pairingRuntime {
            runtime.backgrounded()
        }
        pairingRuntimeOutsideTable?.backgrounded()
    }

    // MARK: - Focus and navigation

    /// Show and talk to a conversation on the focused host.
    func openConversation(_ id: UInt64) {
        guard let hostKey = runtimeTable.focus?.hostKey else { return }
        openConversation(ConversationRef(hostKey: hostKey, conversationId: id))
    }

    /// Show a conversation, moving the one focus. The previous host releases
    /// its conversation subscription but keeps its connection (ADR-0035 §2).
    func openConversation(_ ref: ConversationRef) {
        guard let runtime = runtime(for: ref.hostKey) else { return }
        if runtimeTable.focus != HostFocus(hostKey: ref.hostKey, conversationId: ref.conversationId) {
            let released = runtimeTable.focusConversation(ref)
            if let released { runtimes[released.hostKey]?.clearConversation() }
            persistFocus(ref.hostKey)
            syncPhase()
        }
        runtime.openConversation(ref.conversationId)
        updatePushVisibility()
    }

    /// Keep focus on what the stack actually shows: a conversation page owns
    /// the ref, every other page shows the host's draft and releases the
    /// conversation subscription. This is what makes the push banner rule
    /// depend on the visible conversation, not on the app being foregrounded.
    func navigationChanged() {
        guard !pairingOwnsFocus, let hostKey = runtimeTable.focus?.hostKey else { return }
        if case .conversation(let ref)? = navPath.last {
            if ref.hostKey == hostKey, runtimeTable.focus != HostFocus(
                hostKey: ref.hostKey, conversationId: ref.conversationId) {
                let released = runtimeTable.focusConversation(ref)
                if let released { runtimes[released.hostKey]?.clearConversation() }
                persistFocus(ref.hostKey)
                syncPhase()
            }
            updatePushVisibility()
            return
        }
        let released = runtimeTable.focusDraft(on: hostKey)
        if let released { runtimes[released.hostKey]?.clearConversation() }
        updatePushVisibility()
    }

    /// Move focus to a host's draft. It never reconnects another host and
    /// never rebuilds a session (issue #428 §8).
    func focus(on hostKey: String) {
        guard runtimeTable.contains(hostKey) else { return }
        if runtimeTable.focus?.hostKey != hostKey {
            let released = runtimeTable.focusDraft(on: hostKey)
            if let released { runtimes[released.hostKey]?.clearConversation() }
            navPath = []
            persistFocus(hostKey)
            syncPhase()
        }
        if runtimes[hostKey] == nil, let host = hosts.hosts.first(where: { $0.hostKey == hostKey }) {
            ensureRuntime(host)
        }
        updatePushVisibility()
    }

    private func persistFocus(_ hostKey: String) {
        do {
            try store.update { stored in
                stored = stored.activating(hostKey)
            }
            hosts = hosts.activating(hostKey)
        } catch {
            lastError = "Couldn't save the selected host (\(describe(error))). The previous host opens after the app restarts."
        }
    }

    // MARK: - Pairing and connection

    /// Start a session pairing with `link`. `focus` is false for an
    /// account-vouched automatic registration, which must not move the screen.
    @discardableResult
    func pair(link: String, account: AccountLink? = nil, focus: Bool = true) -> Bool {
        beginPairing(link: link, account: account, focus: focus, autoRegisterHostId: nil) != nil
    }

    func beginPairing(
        link: String, account: AccountLink?, focus: Bool, autoRegisterHostId: String?
    ) -> HostRuntime? {
        if account == nil { invalidateAccountPairing() }
        do {
            let previous = currentHostKey ?? hosts.active?.hostKey
            let session = try PinomadSession.pair(
                link: link,
                deviceName: DeviceModelName.currentDisplayName(fallback: UIDevice.current.model),
                account: account)
            let runtime = HostRuntime(hostKey: nil, host: nil, isPairing: true)
            runtime.autoRegisterHostId = autoRegisterHostId
            configure(runtime)
            runtime.attach(session, sameHost: false)
            if focus {
                closePairingRuntime()
                pairingRuntime = runtime
                pairingOwnsFocus = true
                pairing.pair(
                    link: link, account: account,
                    target: PinomadCore.pairingTarget(link: link))
                hostBeforePairing = hostBeforePairing ?? previous
                syncPhase()
            } else {
                pairingRuntime = runtime
                if let autoRegisterHostId {
                    automaticPairingRuntimes[autoRegisterHostId] = runtime
                }
            }
            return runtime
        } catch {
            // A background registration must not replace the screen with a
            // failure page; the next account refresh can try again.
            if autoRegisterHostId == nil {
                fail(.unreachable(describe(error)))
            }
            return nil
        }
    }

    /// Start a session for a stored host and show it.
    func connect(_ host: HostRecord) {
        invalidateAccountPairing()
        ensureRuntime(host)
        focus(on: host.hostKey)
    }

    /// Re-read the keychain and connect every stored host, restoring the
    /// remembered focus. Existing runtimes are kept (cancel pairing, returning
    /// from a forgotten host), only missing ones are built.
    func connectActive() {
        invalidateAccountPairing()
        do {
            hosts = try store.load()
            hostsLoaded = true
            globalFailure = nil
        } catch {
            closeAllRuntimes()
            fail(.unreachable("Couldn't read the saved pairings: \(describe(error))"))
            return
        }
        if hosts.hosts.isEmpty && unsavedHostKeys.isEmpty {
            closeAllRuntimes()
            phase = .pairing
            navPath = []
            advancePushTarget()
            return
        }
        synchronizeRuntimes(rememberedHostKey: hosts.activeHostKey)
        syncPhase()
        advancePushTarget()
    }

    /// Refresh `hosts` from the keychain; a failed read keeps the last good
    /// list (connecting reports it, see `connectActive`).
    func reloadHosts() {
        guard let stored = try? store.load() else { return }
        hosts = stored
        hostsLoaded = true
        synchronizeRuntimes(rememberedHostKey: stored.activeHostKey)
        syncPhase()
        advancePushTarget()
    }

    /// Bring the runtime table in line with the keychain: update records,
    /// build/connect missing hosts, close forgotten ones, and keep the focus
    /// on a host that still exists.
    private func synchronizeRuntimes(rememberedHostKey: String?) {
        var keys = hosts.hosts.map(\.hostKey)
        keys.append(contentsOf: unsavedHostKeys.filter { !keys.contains($0) })
        for key in runtimes.keys.filter({ !keys.contains($0) }) {
            runtimes.removeValue(forKey: key)?.close()
        }
        for host in hosts.hosts {
            if let runtime = runtimes[host.hostKey] {
                runtime.updateHost(host)
                if runtime.session == nil { startSession(runtime, host: host) }
            } else {
                ensureRuntime(host)
            }
        }
        for key in unsavedHostKeys {
            if let runtime = runtimes[key] {
                if runtime.session == nil, let host = runtime.host {
                    startSession(runtime, host: host)
                }
            } else if let host = hosts.hosts.first(where: { $0.hostKey == key }) {
                ensureRuntime(host)
            }
        }
        if runtimeTable.hostKeys.isEmpty {
            runtimeTable = HostRuntimeTable(
                hostKeys: keys, rememberedHostKey: rememberedHostKey)
        } else {
            let released = runtimeTable.synchronize(keys)
            if let released { runtimes[released.hostKey]?.clearConversation() }
        }
    }

    @discardableResult
    private func ensureRuntime(_ host: HostRecord) -> HostRuntime {
        if let runtime = runtimes[host.hostKey] {
            runtime.updateHost(host)
            if runtime.session == nil { startSession(runtime, host: host) }
            return runtime
        }
        let runtime = HostRuntime(hostKey: host.hostKey, host: host, isPairing: false)
        configure(runtime)
        runtimes[host.hostKey] = runtime
        startSession(runtime, host: host)
        return runtime
    }

    private func startSession(_ runtime: HostRuntime, host: HostRecord) {
        do {
            let session = try PinomadSession.connect(host: host)
            // A rebuilt session for the same identity keeps the reader's
            // drafts and page; a fresh runtime starts clean.
            runtime.attach(session, sameHost: runtime.generation > 0)
        } catch {
            runtime.fail(.unreachable(describe(error)))
        }
    }

    /// Retry this identity: stop its session and build a fresh one. Only the
    /// focused runtime is rebuilt.
    private func restart(_ runtime: HostRuntime) {
        guard let host = runtime.host else { return }
        if case .conversation(let ref) = navPath.last, ref.hostKey == host.hostKey {
            runtime.reopenAfterReady = ref.conversationId
        }
        runtime.close()
        startSession(runtime, host: host)
        syncPhase()
    }

    /// The host to offer going back to from a failure page.
    var previousHostKey: String? {
        guard let key = hostBeforePairing, key != currentHostKey,
              hosts.hosts.contains(where: { $0.hostKey == key })
        else { return nil }
        return key
    }

    /// Try again on the focused host — a pairing link, else a fresh session.
    func retryConnection() {
        switch pairing.retry {
        case .link(let link, let account):
            pair(link: link, account: account)
        case .host(let host):
            if let runtime = runtimes[host.hostKey] {
                restart(runtime)
            } else {
                ensureRuntime(host)
            }
        case .active:
            if let runtime = focusedRuntime, !runtime.isPairing, runtime.host != nil {
                restart(runtime)
            } else {
                connectActive()
            }
        }
    }

    /// Cancel a pairing whose handshake has not completed; a completed one
    /// keeps the stored host and only loses the pair page.
    func cancelPairing() {
        if let runtime = pairingRuntime {
            if let key = runtime.hostKey, !hosts.hosts.contains(where: { $0.hostKey == key }) {
                runtime.close()
                runtimes.removeValue(forKey: key)
                unsavedHostKeys.remove(key)
            } else if runtime.session == nil {
                runtime.close()
            }
        }
        pairingRuntime = nil
        pairingOwnsFocus = false
        pairing.clear()
        hostBeforePairing = nil
        connectActive()
    }

    /// Stop tracking the old pairing session without touching a host that
    /// already joined the table: starting a new pairing must not close any
    /// established host's connection (ADR-0035 §2).
    private func closePairingRuntime() {
        if let runtime = pairingRuntime {
            let stored = runtime.hostKey.map { key in
                hosts.hosts.contains(where: { $0.hostKey == key })
            } ?? false
            if !stored {
                runtime.close()
                if let key = runtime.hostKey {
                    runtimes.removeValue(forKey: key)
                    unsavedHostKeys.remove(key)
                }
            }
        }
        pairingRuntime = nil
        pairingOwnsFocus = false
    }

    private func closeAllRuntimes() {
        for runtime in runtimes.values { runtime.close() }
        runtimes.removeAll()
        for runtime in automaticPairingRuntimes.values { runtime.close() }
        automaticPairingRuntimes.removeAll()
        accountRegistrationInFlight.removeAll()
        pairingRuntime?.close()
        pairingRuntime = nil
        pairingOwnsFocus = false
        runtimeTable = HostRuntimeTable(hostKeys: [])
        unsavedHostKeys.removeAll()
    }

    /// Forget one host: close only its runtime, clear its push registration,
    /// and remember the decline if it was an account host (ADR-0035 §5).
    func forget(_ hostKey: String) {
        #if DEBUG
        if devHostsInjected {
            showToast("Demo data: hosts aren't forgotten.")
            return
        }
        #endif
        let record = hostRecord(for: hostKey)
        let plan = pushForgetPlan(
            mayHaveRegistration: push.mayHaveRegistration(for: hostKey),
            canClear: canClearPushRegistration(for: hostKey))
        forgettingHosts.insert(hostKey)
        Task { [weak self] in
            guard let self else { return }
            var warning: String?
            switch plan {
            case .forget:
                break
            case .forgetWithWarning:
                warning = "Forgot this host. It may still have this device registered for notifications; revoke this device on the host's Devices page to stop them."
            case .clearThenForget:
                do {
                    guard let session = self.runtimes[hostKey]?.session else {
                        throw SessionError.sessionClosed
                    }
                    try await self.clearPushRegistration(on: session)
                    self.push.setMayHaveRegistration(false, for: hostKey)
                } catch is PushUnregisterTimeout {
                    warning = "Forgot this host, but the host timed out clearing notifications. Revoke this device on the host's Devices page to stop them."
                } catch {
                    warning = "Forgot this host, but couldn't clear notifications (\(self.describe(error))). Revoke this device on the host's Devices page to stop them."
                }
            }
            self.forgetNow(hostKey, record: record, warning: warning)
        }
    }

    private func canClearPushRegistration(for hostKey: String) -> Bool {
        guard let runtime = runtimes[hostKey] else { return false }
        return runtime.isConnectedNow && hostSupportsCall(
            hostMinor: runtime.hostMinor, method: "setPushToken")
    }

    /// The clear is bounded: a black-holed connection must not keep the
    /// pairing on the device forever.
    private func clearPushRegistration(on session: PinomadSession) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                _ = try await session.invoke(.setPushToken(token: nil))
            }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                throw PushUnregisterTimeout()
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    private func forgetNow(_ hostKey: String, record: HostRecord?, warning: String?) {
        forgettingHosts.remove(hostKey)
        // Cancelling in-flight registrations for this identity is part of
        // forgetting it; a late handshake must not resurrect it.
        accountPairingGeneration &+= 1
        if let account = record?.account {
            accountRegistrationInFlight.remove(account.hostId)
            unsavedAccountHosts.removeValue(forKey: account.hostId)
            if let runtime = automaticPairingRuntimes.removeValue(forKey: account.hostId) {
                runtime.close()
                if pairingRuntime === runtime { pairingRuntime = nil }
            }
        }
        do {
            try store.update { $0 = $0.forgetting(hostKey) }
        } catch {
            lastError = "Couldn't forget this host: \(describe(error))"
            return
        }
        if let account = record?.account {
            declinedAccountHosts.add(serverOrigin: account.serverOrigin, hostId: account.hostId)
        }
        push.forget(hostKey)
        accountHostForgotten(hostKey)
        runtimes.removeValue(forKey: hostKey)?.close()
        unsavedHostKeys.remove(hostKey)
        let wasFocused = runtimeTable.focus?.hostKey == hostKey
        let released = runtimeTable.forget(hostKey)
        if let released { runtimes[released.hostKey]?.clearConversation() }
        if wasFocused { navPath = [] }
        reloadHosts()
        if runtimeTable.hostKeys.isEmpty && !pairingOwnsFocus {
            phase = .pairing
        }
        if let warning { pushForgetWarning = warning }
        updatePushVisibility()
        advancePushTarget()
    }

    func setConnectionMode(_ mode: HostConnectionMode, for hostKey: String) {
        do {
            try store.update { stored in
                if let next = stored.settingConnectionMode(mode, for: hostKey) {
                    stored = next
                }
            }
        } catch {
            lastError = "Couldn't save this host's connection mode (\(describe(error)))."
            return
        }
        reloadHosts()
        guard let runtime = runtimes[hostKey], let host = hostRecord(for: hostKey) else { return }
        runtime.updateHost(host)
        restart(runtime)
    }

    func connectionMode(for hostKey: String) -> HostConnectionMode {
        hostRecord(for: hostKey)?.connectionMode ?? .auto
    }

    func hostRecord(for hostKey: String) -> HostRecord? {
        hosts.hosts.first { $0.hostKey == hostKey }
            ?? runtimes[hostKey]?.host
            ?? (sessionHost?.hostKey == hostKey ? sessionHost : nil)
    }

    func fail(_ failure: ConnectFailure) {
        globalFailure = failure
        phase = .failed(failure)
        navPath = []
        push.visibleConversation = nil
    }

    // MARK: - Snapshot and lifecycle wiring

    private func configure(_ runtime: HostRuntime) {
        runtime.onReady = { [weak self] runtime in
            guard let self else { return }
            if runtime === self.focusedRuntime { self.syncPhase() }
            self.syncPushToken(for: runtime)
            self.advancePushTarget()
        }
        runtime.onSnapshot = { [weak self] runtime, snapshot in
            guard let self else { return }
            self.receivedSnapshot(runtime, snapshot: snapshot)
        }
        runtime.onPaired = { [weak self] runtime, host, saveError in
            guard let self else { return }
            self.paired(runtime, host: host, saveError: saveError)
        }
        runtime.onEndpoints = { [weak self] runtime, host, _ in
            guard let self else { return }
            self.applyEndpointPatch(host, from: runtime)
        }
        runtime.onFailure = { [weak self] runtime, failure in
            guard let self else { return }
            if runtime === self.focusedRuntime { self.syncPhase() }
            self.handleRegistrationFailure(runtime, failure: failure)
        }
        runtime.onUnauthorized = { [weak self] runtime, host in
            guard let self else { return }
            self.markAccountRejected(host)
        }
        runtime.onHostName = { [weak self] hostKey, name in
            self?.cacheHostName(name, for: hostKey)
        }
        runtime.onConnectedEdge = { [weak self] runtime in
            self?.syncPushToken(for: runtime)
        }
        runtime.onConnectedView = { [weak self] runtime in
            self?.retryQueuedEditIfNeeded(for: runtime)
        }
        runtime.onToast = { [weak self] runtime, notice in
            self?.presentToast(runtime, notice: notice)
        }
    }

    private func receivedSnapshot(_ runtime: HostRuntime, snapshot: ClientSnapshot) {
        guard runtime === focusedRuntime else { return }
        syncPhase()
        updatePushVisibility()
        signposter.emitEvent(
            "ui-publish",
            "\(runtime.hostKey.map { String($0.suffix(8)) } ?? "-", privacy: .public)")
        PerfLog.shared.mark("ui-publish", version: snapshot.version, host: runtime.hostKey)
        if let conversation = snapshot.conversation {
            PerfLog.shared.mark(
                "conv-\(conversation.id)-\(conversation.chat.count)", host: runtime.hostKey)
        }
        PerfLog.shared.flush()
        advancePushTarget()
    }

    private func syncPhase() {
        if let globalFailure {
            phase = .failed(globalFailure)
            return
        }
        if pairingOwnsFocus, let pairingRuntime {
            phase = appPhase(pairingRuntime.phase)
            return
        }
        guard let runtime = focusedRuntime else {
            phase = hostsLoaded && hosts.hosts.isEmpty ? .pairing : .loading
            return
        }
        phase = appPhase(runtime.phase)
    }

    private func appPhase(_ phase: HostRuntime.Phase) -> Phase {
        switch phase {
        case .connecting: .connecting
        case .connected: .connected
        case .failed(let failure): .failed(failure)
        }
    }

    private func paired(_ runtime: HostRuntime, host: HostRecord, saveError: String?) {
        runtime.identify(host)
        runtimes[host.hostKey] = runtime
        accountRejectedHostKeys.remove(host.hostKey)
        if let autoHostId = runtime.autoRegisterHostId {
            runtime.autoRegisterHostId = nil
            automaticPairingRuntimes.removeValue(forKey: autoHostId)
            accountRegistrationInFlight.remove(autoHostId)
            // A forget or explicit decline during the handshake wins over the
            // late registration (ADR-0035 §5).
            if let account = host.account,
               declinedAccountHosts.contains(
                serverOrigin: account.serverOrigin, hostId: account.hostId) {
                accountRegistrationInFlight.remove(autoHostId)
                runtime.close()
                runtimes.removeValue(forKey: host.hostKey)
                return
            }
            if saveError != nil {
                // The host registered this device; only the local write
                // failed. Keep the identity for a save-only retry and close
                // the live connection so it is not an invisible extra host.
                unsavedAccountHosts[autoHostId] = host
                runtime.close()
                runtimes.removeValue(forKey: host.hostKey)
            } else {
                runtimeTable.addPairedHost(host.hostKey, focus: false)
                // The core marks every newly saved pairing as the launch
                // host; an automatic one must not steal the remembered focus.
                if let focusKey = runtimeTable.focus?.hostKey {
                    try? store.update { $0 = $0.activating(focusKey) }
                }
                reloadHosts()
            }
            accountRefreshAfterPairing()
            return
        }

        pairing.paired(host)
        pairingOwnsFocus = false
        if saveError != nil { unsavedHostKeys.insert(host.hostKey) }
        let released = runtimeTable.addPairedHost(host.hostKey, focus: true)
        if let released { runtimes[released.hostKey]?.clearConversation() }
        navPath = []
        pairings += 1
        reloadHosts()
        syncPhase()
        accountRefreshAfterPairing()
        advancePushTarget()
    }

    /// An account registration that never named its host has no table entry;
    /// drop it and let the next refresh decide again.
    private func handleRegistrationFailure(_ runtime: HostRuntime, failure: ConnectFailure) {
        guard let hostId = runtime.autoRegisterHostId else { return }
        accountRegistrationInFlight.remove(hostId)
        automaticPairingRuntimes.removeValue(forKey: hostId)
        runtime.close()
        if pairingRuntime === runtime { pairingRuntime = nil }
    }

    private func applyEndpointPatch(_ patch: HostRecord, from runtime: HostRuntime) {
        if pairingOwnsFocus, pairing.host?.hostKey == patch.hostKey {
            pairing.endpoints(patch)
        }
        guard let set = patch.endpointSet,
              let next = hosts.settingEndpoints(set, url: patch.url, for: patch.hostKey)
        else { return }
        hosts = next
        runtime.updateHost(patch)
    }

    func streamFor(_ entryId: String) -> StreamingMarkdown? {
        focusedRuntime?.replyStreams.stream(for: entryId)
    }

    func dismissToast(_ id: UInt64) {
        toasts.removeAll { $0.id == id }
    }

    func showToast(_ message: String, level: String = "info") {
        guard let runtime = focusedRuntime else { return }
        presentToast(runtime, notice: Notice(id: 0, level: level, message: message))
    }

    /// One toast stack for all hosts. Ids are renumbered here: core notice
    /// ids restart per session and would collide across hosts. The source
    /// machine is named only when there is more than one to tell apart.
    private func presentToast(_ runtime: HostRuntime, notice: Notice) {
        nextToastID &-= 1
        var message = notice.message
        if hosts.hosts.count > 1, let hostKey = runtime.hostKey, let label = hostLabels[hostKey] {
            message = "\(label): \(message)"
        }
        let toast = Notice(id: nextToastID, level: notice.level, message: message)
        toasts.append(toast)
        if toasts.count > 3 { toasts.removeFirst(toasts.count - 3) }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.dismissToast(toast.id)
        }
    }

    func refreshRtcStatus() {
        focusedRuntime?.refreshRtcStatus()
    }

    func refreshLiveRtcStatus() {
        focusedRuntime?.refreshLiveRtcStatus()
    }

    /// "Connected · P2P" / "Relay" / "Direct" / "Local" for the focused
    /// host; nil when nothing is connected.
    var connectedSummary: String? {
        guard phase == .connected, let snapshot, snapshot.connection == .connected,
              !snapshot.unauthorized
        else { return nil }
        let path: String
        switch rtcStatus?.path {
        case "p2p": path = "P2P"
        case "relay": path = "Relay"
        case "direct": path = "Direct"
        default: path = "Local"
        }
        return "Connected · \(path)"
    }

    /// Whether one host's runtime is connected, for per-host status rows.
    func isConnected(_ hostKey: String) -> Bool {
        runtimes[hostKey]?.isConnectedNow ?? false
    }

    /// One host's live RTC status, for its own connection page.
    func rtcStatus(for hostKey: String) -> RtcDiagnostics? {
        runtimes[hostKey]?.rtcStatus
    }

    func rtcStatusAt(for hostKey: String) -> Date {
        runtimes[hostKey]?.rtcStatusAt ?? .distantPast
    }

    func refreshLiveRtcStatus(for hostKey: String) {
        runtimes[hostKey]?.refreshLiveRtcStatus()
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

    func modalDismissed() {
        guard let next = nextModal else { return }
        nextModal = nil
        modal = next
    }

    private func runtime(for hostKey: String) -> HostRuntime? {
        if let runtime = runtimes[hostKey] { return runtime }
        guard let host = hosts.hosts.first(where: { $0.hostKey == hostKey }) else { return nil }
        return ensureRuntime(host)
    }
}
