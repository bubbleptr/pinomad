import Foundation
import Observation
import PinomadChat
import PinomadCore
import UIKit

/// One paired host's connection and the UI state that belongs to it
/// (ADR-0035 §3). Runtimes are independent: each owns a `PinomadSession`, its
/// generation, snapshot, caches, reply streams and composer state, so a late
/// update from one host can never land on another. AppModel keeps the table
/// and the single focus.
@MainActor @Observable
final class HostRuntime {
    enum Phase: Equatable {
        case connecting
        case connected
        case failed(ConnectFailure)
    }

    /// nil only while a pairing handshake has not named its host yet.
    private(set) var hostKey: String?
    var host: HostRecord?
    /// Manual pairing and account-vouched registration both start without a
    /// stored record; the failure text distinguishes them.
    let isPairing: Bool
    /// Set for an account registration so its late handshake can be dropped
    /// after sign-out or a forget.
    var autoRegisterHostId: String?

    private(set) var session: PinomadSession?
    private(set) var snapshot: ClientSnapshot?
    private(set) var phase: Phase = .connecting
    /// Bumped whenever this runtime's session is replaced or stopped. Every
    /// asynchronous continuation checks it before touching this host's state.
    private(set) var generation: UInt64 = 0
    private var connectAttempt: ConnectAttempt?

    var lastError = ""
    var pairingWarning = PairingWarningState()
    var rtcStatus: RtcDiagnostics?
    var rtcStatusAt = Date()
    var skillCache = SkillListCache()
    var commandCache = CommandListCache()
    let replyStreams = ReplyStreams()
    var lastSnapshotConnected = false
    var lastConversationFreshEpoch: UInt64 = 0
    /// Bumped when this host's shown ref subscription becomes fresh, so a
    /// failed ref image can retry. AppModel mirrors the focused host's value
    /// into the environment.
    private(set) var imageEpoch: UInt64 = 0
    var opening = ConversationOpening()
    var reopenAfterReady: UInt64?

    var toasts: [Notice] = []
    private var noticeFeed = NoticeFeed()
    private var reconnectNotice = ReconnectNotice()
    private var reconnectNoticeDeadline: ContinuousClock.Instant?
    private var reconnectNoticeTimer: Task<Void, Never>?
    private(set) var showsReconnecting = false

    // Per-conversation composer state. One runtime is one host, so the
    // conversation id is enough of a key here; the ref's hostKey is this
    // runtime's own.
    var drafts: [UInt64: String] = [:]
    var skillChips: [UInt64: SkillChips] = [:]
    var trays: [UInt64: AttachmentTray] = [:]
    var fileTrays: [UInt64: FileAttachmentTray] = [:]
    var fileReads: [UInt64: Set<UUID>] = [:]
    var queuedEdit = QueuedEdit()
    var queuedEditPreparing: Set<UInt64> = []
    var queuePending: Set<UInt64> = []
    var queuedEditFocus: [UInt64: UInt64] = [:]
    var takingBack: UInt64?
    var submissionPending: Set<String> = []
    var sentFileDetails: [String: [UserAttachment]] = [:]
    var questionDrafts: [String: QuestionDraft] = [:]
    var viewing: MessageImage?
    var transcriptPin = 0

    // The new-conversation draft belongs to the host, not to the screen
    // (ADR-0035 §3): switching focus keeps each host's text and attachments.
    var draftHome: NewConversationHome = .chat
    var draftCheckout: ConversationCheckout = .worktree
    var draftAgent = AgentDraftPick()
    var creating = false

    // AppModel installs these so the composition root can update the focus,
    // push registration, account rows and PerfLog.
    var onReady: ((HostRuntime) -> Void)?
    var onSnapshot: ((HostRuntime, ClientSnapshot) -> Void)?
    var onPaired: ((HostRuntime, HostRecord, String?) -> Void)?
    var onEndpoints: ((HostRuntime, HostRecord, String?) -> Void)?
    var onFailure: ((HostRuntime, ConnectFailure) -> Void)?
    var onUnauthorized: ((HostRuntime, HostRecord) -> Void)?
    var onHostName: ((String, String) -> Void)?
    var onConnectedEdge: ((HostRuntime) -> Void)?
    /// Every connected view, not just the first edge: ViewChanged coalescing
    /// can hide the offline snapshot, so the queue retry is checked each time.
    var onConnectedView: ((HostRuntime) -> Void)?
    /// The composition root shows toasts for every host, not just the
    /// focused one, and attributes them when more than one is paired.
    var onToast: ((HostRuntime, Notice) -> Void)?

    init(hostKey: String?, host: HostRecord?, isPairing: Bool) {
        self.hostKey = hostKey
        self.host = host
        self.isPairing = isPairing
    }

    var isConnectedNow: Bool {
        guard let snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    var hostMinor: UInt32 { snapshot?.host?.protocol.minor ?? 0 }

    var name: String? { host?.name }

    /// Take over a freshly built session. `sameHost` is a retry/reconnect for
    /// the identity already in this runtime; its drafts and page stay.
    func attach(_ session: PinomadSession, sameHost: Bool) {
        generation &+= 1
        let generation = generation
        connectAttempt?.stop()
        connectAttempt = nil
        self.session?.close()
        self.session = session
        snapshot = nil
        pairingWarning.clear()
        lastError = ""
        lastSnapshotConnected = false
        lastConversationFreshEpoch = 0
        submissionPending.removeAll()
        takingBack = nil
        fileReads = [:]
        replyStreams.sync(chat: nil)
        toasts = []
        noticeFeed = NoticeFeed()
        reconnectNotice = ReconnectNotice()
        refreshReconnectNotice()
        if !sameHost { resetComposerState() }
        phase = .connecting
        let attempt = ConnectAttempt(
            updates: session.updates,
            close: { session.close() },
            apply: { [weak self] update in
                guard let self, self.generation == generation else { return }
                self.apply(update)
            })
        connectAttempt = attempt
        attempt.start()
    }

    /// A session that never got built (validation or keychain failure) shows
    /// the same failure page as a ready-time one.
    func fail(_ failure: ConnectFailure) {
        phase = .failed(failure)
        onFailure?(self, failure)
    }

    func close() {
        generation &+= 1
        connectAttempt?.stop()
        connectAttempt = nil
        session?.close()
        session = nil
        snapshot = nil
        lastSnapshotConnected = false
        lastConversationFreshEpoch = 0
        reconnectNoticeTimer?.cancel()
        reconnectNoticeTimer = nil
    }

    /// The handshake named the host. The runtime may have been created as a
    /// pairing placeholder; from here it can join the table.
    func identify(_ host: HostRecord) {
        self.host = host
        if hostKey == nil { hostKey = host.hostKey }
    }

    /// A stored record changed under the same key: name, endpoints, account
    /// link or connection mode. Never the identity used by a live session.
    func updateHost(_ next: HostRecord) {
        guard next.hostKey == hostKey else { return }
        host = next
    }

    func resetComposerState() {
        drafts = [:]
        skillChips = [:]
        trays = [:]
        fileTrays = [:]
        fileReads = [:]
        queuedEdit.reset()
        queuedEditPreparing.removeAll()
        queuePending.removeAll()
        queuedEditFocus = [:]
        sentFileDetails = [:]
        questionDrafts = [:]
        viewing = nil
        transcriptPin = 0
        draftHome = .chat
        draftCheckout = .worktree
        draftAgent.reset()
        creating = false
        opening = ConversationOpening()
        reopenAfterReady = nil
    }

    private func apply(_ update: SessionUpdate) {
        pairingWarning.apply(update)
        switch update {
        case .ready(let outcome):
            if outcome == .unauthorized, let host {
                onUnauthorized?(self, host)
            }
            if let failure = ConnectFailure(outcome: outcome, pairing: isPairing) {
                phase = .failed(failure)
                onFailure?(self, failure)
                return
            }
            phase = .connected
            refreshRtcStatus()
            onReady?(self)
            if let id = reopenAfterReady {
                reopenAfterReady = nil
                openConversation(id)
            }
        case .candidateFailed:
            break
        case .endpoints(let host, let saveError):
            self.host = host
            if let saveError {
                lastError = "Couldn't save this host's updated addresses (\(saveError)). The connection is still live."
            }
            onEndpoints?(self, host, saveError)
        case .paired(let host, let saveError):
            identify(host)
            if let saveError {
                lastError = "Couldn't save this host (\(saveError))."
            }
            onPaired?(self, host, saveError)
        case .snapshot(let snapshot):
            if let failure = ConnectFailure(snapshot: snapshot) {
                phase = .failed(failure)
                onFailure?(self, failure)
            }
            self.snapshot = snapshot
            refreshRtcStatus()
            let freshEpoch = snapshot.conversation?.freshEpoch ?? 0
            if freshEpoch > lastConversationFreshEpoch { imageEpoch &+= 1 }
            lastConversationFreshEpoch = freshEpoch
            if let hostKey, let announced = snapshot.hostName {
                onHostName?(hostKey, announced)
            }
            let connectedNow = snapshot.connection == .connected && !snapshot.unauthorized
            // A failure page explains itself; the core's notice for the same
            // thing (e.g. the 4401) would only repeat it.
            if phase == .connected {
                for notice in noticeFeed.fresh(snapshot.notices) { show(notice) }
            } else {
                _ = noticeFeed.fresh(snapshot.notices)
            }
            if connectedNow && !lastSnapshotConnected { onConnectedEdge?(self) }
            if connectedNow { onConnectedView?(self) }
            lastSnapshotConnected = connectedNow
            reconnectNotice.observe(
                reconnecting: snapshot.connection == .reconnecting, at: .now)
            refreshReconnectNotice()
            replyStreams.sync(chat: snapshot.conversation?.chat)
            onSnapshot?(self, snapshot)
        case .platformError(let message):
            lastError = message
        }
    }

    /// Show "Connecting…" if the grace window is over, else wake at its end.
    private func refreshReconnectNotice() {
        let visible = reconnectNotice.isVisible(at: .now)
        if showsReconnecting != visible { showsReconnecting = visible }
        let deadline = visible ? nil : reconnectNotice.deadline
        guard deadline != reconnectNoticeDeadline else { return }
        reconnectNoticeDeadline = deadline
        reconnectNoticeTimer?.cancel()
        reconnectNoticeTimer = deadline.map { deadline in
            Task { [weak self] in
                guard (try? await Task.sleep(until: deadline, clock: .continuous)) != nil else { return }
                self?.refreshReconnectNotice()
            }
        }
    }

    func foregrounded() {
        if reconnectNotice.since != nil {
            reconnectNotice.restart(at: .now)
            refreshReconnectNotice()
        }
        session?.notifyForeground()
    }

    func backgrounded() {
        session?.notifyBackground()
    }

    func networkChanged() {
        session?.notifyNetworkChanged()
    }

    /// The RTC status is only meaningful for this runtime's live session.
    func refreshRtcStatus() {
        guard let session else {
            rtcStatus = nil
            return
        }
        setRtcStatus(session.rtcDiagnostics())
    }

    func refreshLiveRtcStatus() {
        guard phase == .connected, let session else { return }
        setRtcStatus(session.rtcDiagnostics())
    }

    private func setRtcStatus(_ next: RtcDiagnostics) {
        let previous = rtcStatus
        rtcStatus = next
        if previous == nil
            || previous?.phase != next.phase
            || previous?.path != next.path
            || previous?.cooldownRemainingMs != next.cooldownRemainingMs
            || previous?.lastFailure != next.lastFailure
        {
            rtcStatusAt = Date()
        }
    }

    /// Show and talk to a conversation on this host. A refused switch lands
    /// as a snapshot notice, not a thrown error.
    func openConversation(_ id: UInt64) {
        let attempt = opening.begin(id)
        let generation = generation
        Task { [weak self] in
            guard let self, self.generation == generation, let session = self.session else {
                self?.opening.settle(id, attempt: attempt, shown: nil)
                return
            }
            _ = try? await session.invoke(.switchConversation(id: id))
            let shown = await Task.detached { session.shownConversationNow }.value
            guard self.generation == generation else { return }
            self.opening.settle(id, attempt: attempt, shown: shown)
        }
    }

    /// Release this host's conversation subscription while its connection,
    /// uploads and unsettled submissions keep running (ADR-0035 §2).
    func clearConversation() {
        guard let session else { return }
        Task { _ = try? await session.invoke(.clearConversation) }
    }

    /// Debug demos publish synthetic views through the same runtime slot the
    /// session fills, so every proxy observes one shape.
    func publishDevelopmentSnapshot(_ snapshot: ClientSnapshot) {
        self.snapshot = snapshot
        phase = .connected
        lastSnapshotConnected = snapshot.connection == .connected && !snapshot.unauthorized
        replyStreams.sync(chat: snapshot.conversation?.chat)
    }

    func show(_ notice: Notice) {
        if let onToast {
            onToast(self, notice)
            return
        }
        toasts.append(notice)
        if toasts.count > 3 { toasts.removeFirst(toasts.count - 3) }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.dismissToast(notice.id)
        }
    }

    func dismissToast(_ id: UInt64) {
        toasts.removeAll { $0.id == id }
    }

    /// A notice the app produced for this host (queued-action outcomes and
    /// refusals). The descending id stays clear of the core's notice feed.
    func showToast(_ message: String, level: String = "info") {
        Self.nextLocalToastID &-= 1
        show(Notice(id: Self.nextLocalToastID, level: level, message: message))
    }

    private static var nextLocalToastID: UInt64 = .max
}
