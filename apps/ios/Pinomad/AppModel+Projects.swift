import Foundation
import PinomadChat
import PinomadCore

/// The new-conversation draft, projects, and per-conversation management
/// (rename, archive).
extension AppModel {
    /// Drafts and trays key the new-conversation draft here — no real
    /// conversation id reaches it.
    static let draftKey = UInt64.max

    var connected: Bool {
        guard let snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    /// Whether the host knows `method` — older hosts reject calls added
    /// after them, so their entry points are hidden.
    func hostSupports(_ method: String) -> Bool {
        hostSupportsCall(hostMinor: snapshot?.host?.protocol.minor ?? 0, method: method)
    }

    /// Whether the host honors a call-arg feature — older hosts silently
    /// ignore the arg, so the picker stays hidden.
    func hostSupports(_ feature: HostFeature) -> Bool {
        hostSupportsFeature(hostMinor: snapshot?.host?.protocol.minor ?? 0, feature: feature)
    }

    /// The draft's model and level: the named-agent resolution while one is
    /// picked, else the remembered pick reconciled against this host.
    var effectiveDraftPick: ModelPick {
        draftAgent.pick(agents: snapshot?.agents, models: snapshot?.models ?? [],
                        defaults: snapshot?.defaults)
    }

    /// The named-agent derivation (display values, sources, problem) while
    /// one is picked; nil for an unassigned draft.
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

    /// Create a conversation from the draft and show it in place of the
    /// draft page. The call is command-class: it "succeeds" either way, so
    /// success means a snapshot showing a conversation the host hadn't
    /// listed before (an earlier queued switch may publish in the meantime
    /// — that one is known); a new notice (the host's refusal) or a
    /// timeout means it failed, and the draft stays for another try.
    func createConversation() async {
        let key = Self.draftKey
        let text = drafts[key] ?? ""
        let tray = trays[key] ?? AttachmentTray()
        guard !creating, let session,
              !text.allSatisfy(\.isWhitespace) || !tray.images.isEmpty, tray.preparing == 0
        else { return }
        guard let organized = snapshot?.organized else { return }
        let known = KnownConversations(organized)
        let noticesBefore = snapshot?.notices.map(\.id).max() ?? 0
        let models = snapshot?.models ?? []
        let defaults = snapshot?.defaults
        // An unresolved or unavailable named agent blocks the create rather
        // than silently falling back (ADR-0023).
        if draftAgent.resolution(agents: snapshot?.agents, models: models, defaults: defaults)?.problem != nil {
            return
        }
        let pick = effectiveDraftPick
        let send = draftAgent.send(agents: snapshot?.agents, models: models, defaults: defaults)
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
            if case .project = draftHome, draftCheckout == .project { return .project }
            return nil
        }()
        // The `$` picks bind on the host only from 5.16 (ADR-0028).
        let payload = chips(for: key).payload(hostMinor: hostMinor)
        creating = true
        defer { creating = false }
        do {
            _ = try await session.invoke(.createConversation(
                home: draftHome, text: payload.text, checkout: checkout,
                model: modelArg, thinkingLevel: levelArg, agent: send?.agent, images: tray.images,
                skills: payload.skills))
        } catch {
            lastError = "Couldn't create conversation: \(describe(error))"
            return
        }
        // The op resolves before its snapshot is published — wait for it.
        for _ in 0..<120 {
            if let shown = known.created(shown: snapshot?.conversation?.id) {
                drafts[key] = nil
                skillChips[key] = nil
                trays[key] = nil
                // The next draft starts from "no agent", as on the web; the
                // remembered model/level stays.
                draftAgent.clearAgent()
                navPath = [.conversation(shown)]
                return
            }
            if (snapshot?.notices.map(\.id).max() ?? 0) > noticesBefore { return }
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

    /// Register a folder as a project and make it the draft's home.
    func addProject(_ path: String) async throws {
        guard let session else { throw SessionError.sessionClosed }
        guard case .project(let project) = try await session.invoke(.addProject(path: path)) else {
            throw SessionError.operationFailed("The host's reply wasn't a project")
        }
        draftHome = .project(path: project.path ?? path)
    }

    func rename(conversation id: UInt64, to title: String) async throws {
        guard let session else { throw SessionError.sessionClosed }
        _ = try await session.invoke(.renameConversation(id: id, title: title))
    }

    func archive(conversation id: UInt64, _ archived: Bool) {
        guard let session else { return }
        Task { _ = try? await session.invoke(.archive(id: id, archived: archived)) }
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
