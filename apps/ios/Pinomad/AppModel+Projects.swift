import Foundation
import PinomadChat
import PinomadCore

/// The new-conversation draft, projects, and per-conversation management
/// (rename, archive). The draft lives on the focused host's runtime, so a
/// focus change shows that host's own draft instead of migrating anything
/// (ADR-0035 §3).
extension AppModel {
    /// Drafts and trays key the new-conversation draft here — no real
    /// conversation id reaches it.
    static let draftKey = UInt64.max

    var connected: Bool {
        guard let snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    /// Whether the focused host knows `method` — older hosts reject calls added
    /// after them, so their entry points are hidden.
    func hostSupports(_ method: String) -> Bool {
        hostSupportsCall(hostMinor: snapshot?.host?.protocol.minor ?? 0, method: method)
    }

    /// Whether the focused host honors a call-arg feature.
    func hostSupports(_ feature: HostFeature) -> Bool {
        hostSupportsFeature(hostMinor: snapshot?.host?.protocol.minor ?? 0, feature: feature)
    }

    /// The draft's model and level: the named-agent resolution while one is
    /// picked, else the remembered pick reconciled against this host.
    var effectiveDraftPick: ModelPick {
        draftAgent.pick(agents: snapshot?.agents, models: snapshot?.models ?? [],
                        defaults: snapshot?.defaults)
    }

    /// The named-agent derivation while one is picked; nil for an unassigned
    /// draft.
    var draftResolution: AgentDraft? {
        draftAgent.resolution(agents: snapshot?.agents, models: snapshot?.models ?? [],
                              defaults: snapshot?.defaults)
    }

    func setDraftAgent(_ agent: String?) {
        draftAgent.select(agent)
    }

    func setDraftModel(_ ref: ModelRef) {
        draftAgent.setModel(ref, models: snapshot?.models ?? [], defaults: snapshot?.defaults)
    }

    func setDraftLevel(_ level: ThinkingLevel) {
        draftAgent.setLevel(level, models: snapshot?.models ?? [], defaults: snapshot?.defaults)
    }

    /// Create a conversation from the focused host's draft and show it in
    /// place of the draft page. The call is command-class: success means a
    /// snapshot showing a conversation the host hadn't listed before; a new
    /// notice (the host's refusal) or a timeout means it failed, and the draft
    /// stays for another try.
    func createConversation() async {
        let key = Self.draftKey
        guard let runtime = focusedRuntime, let session = runtime.session, !runtime.creating else { return }
        let text = runtime.drafts[key] ?? ""
        let tray = runtime.trays[key] ?? AttachmentTray()
        var files = runtime.fileTrays[key] ?? FileAttachmentTray()
        guard !text.allSatisfy(\.isWhitespace) || !tray.images.isEmpty || !files.isEmpty,
              tray.preparing == 0, files.canSend, !filePreparing(key, in: runtime)
        else { return }
        if files.expire() {
            runtime.fileTrays[key] = files
            runtime.lastError = "Attachment expired; attach it again"
            return
        }
        guard let snapshot = runtime.snapshot else { return }
        let known = KnownConversations(snapshot.organized)
        let noticesBefore = snapshot.notices.map(\.id).max() ?? 0
        let models = snapshot.models
        let defaults = snapshot.defaults
        // An unresolved or unavailable named agent blocks the create rather
        // than silently falling back (ADR-0023).
        if runtime.draftAgent.resolution(
            agents: snapshot.agents, models: models, defaults: defaults)?.problem != nil {
            return
        }
        let pick = runtime.draftAgent.pick(
            agents: snapshot.agents, models: models, defaults: defaults)
        let send = runtime.draftAgent.send(
            agents: snapshot.agents, models: models, defaults: defaults)
        let modelArg: ModelRef?
        let levelArg: ThinkingLevel?
        if let send {
            // Only overrides ride the call; the host resolves inherited sides
            // from the role (ADR-0023).
            modelArg = send.model
            levelArg = send.level
        } else {
            modelArg = pick.model
            levelArg = pick.level
        }
        let checkout: ConversationCheckout? = {
            if case .project = runtime.draftHome, runtime.draftCheckout == .project { return .project }
            return nil
        }()
        // The `$` picks bind on the host only from 5.16 (ADR-0028).
        let payload = chips(for: key, in: runtime).payload(hostMinor: runtime.hostMinor)
        runtime.creating = true
        defer { runtime.creating = false }
        do {
            _ = try await session.invoke(.createConversation(
                home: runtime.draftHome, text: payload.text, checkout: checkout,
                model: modelArg, thinkingLevel: levelArg, agent: send?.agent, images: tray.images,
                skills: payload.skills, attachments: files.ids))
        } catch {
            runtime.lastError = "Couldn't create conversation: \(describe(error))"
            return
        }
        // The op resolves before its snapshot is published — wait for it.
        for _ in 0..<120 {
            if let shown = known.created(shown: runtime.snapshot?.conversation?.id) {
                runtime.drafts[key] = nil
                runtime.skillChips[key] = nil
                runtime.trays[key] = nil
                runtime.fileTrays[key] = nil
                // The next draft starts from "no agent", as on the web; the
                // remembered model/level stays.
                runtime.draftAgent.clearAgent()
                if runtime === focusedRuntime, let hostKey = runtime.hostKey {
                    navPath = [.conversation(
                        ConversationRef(hostKey: hostKey, conversationId: shown))]
                }
                return
            }
            if (runtime.snapshot?.notices.map(\.id).max() ?? 0) > noticesBefore { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// One page of the host folder picker (request-class: throws the
    /// host's reason). Nil path = the host user's home.
    func listFolders(_ path: String?) async throws -> FolderListing {
        guard let session else { throw SessionError.sessionClosed }
        guard case .folderListing(let listing) = try await session.invoke(.listFolders(path: path)) else {
            throw SessionError.operationFailed("The host's reply wasn't a folder list")
        }
        return listing
    }

    /// File candidates under a conversation's cwd or a project checkout
    /// (request-class: throws the host's reason).
    func listFiles(scope: FileScope, query: String) async throws -> (files: [String], truncated: Bool) {
        guard let session else { throw SessionError.sessionClosed }
        guard case .files(let files, let truncated) = try await session.invoke(
            .listFiles(scope: scope, query: query))
        else {
            throw SessionError.operationFailed("The host's reply wasn't a file list")
        }
        return (files, truncated)
    }

    /// Register a folder as a project and make it the focused host's draft
    /// home.
    func addProject(_ path: String) async throws {
        guard let runtime = focusedRuntime, let session = runtime.session else {
            throw SessionError.sessionClosed
        }
        guard case .project(let project) = try await session.invoke(.addProject(path: path)) else {
            throw SessionError.operationFailed("The host's reply wasn't a project")
        }
        runtime.draftHome = .project(path: project.path ?? path)
    }

    /// Rename on the conversation's own host — a cross-machine list holds
    /// rows of hosts that aren't focused.
    func rename(_ ref: ConversationRef, to title: String) async throws {
        guard let session = runtimes[ref.hostKey]?.session else { throw SessionError.sessionClosed }
        _ = try await session.invoke(.renameConversation(id: ref.conversationId, title: title))
    }

    func archive(_ ref: ConversationRef, _ archived: Bool) {
        guard let session = runtimes[ref.hostKey]?.session else { return }
        Task { _ = try? await session.invoke(.archive(id: ref.conversationId, archived: archived)) }
    }

    /// Whether one host knows `method`, for rows and groups of hosts that
    /// aren't focused.
    func hostSupports(_ method: String, on hostKey: String) -> Bool {
        hostSupportsCall(hostMinor: runtimes[hostKey]?.hostMinor ?? 0, method: method)
    }

    /// The host's own words for a request-class rejection.
    func describe(_ error: Error) -> String {
        switch error {
        case SessionError.operationFailed(let message): message
        case SessionError.connectionLost: "Connection lost"
        case SessionError.sessionClosed: "Connection closed"
        default: error.localizedDescription
        }
    }
}
