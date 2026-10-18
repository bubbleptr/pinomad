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

    /// The draft's model and level: the reader's pick while it's still
    /// listed, else the host default, else the first model (core rule).
    var effectiveDraftPick: ModelPick {
        let models = snapshot?.models ?? []
        let defaults = snapshot?.defaults
        let remembered = draftPick ?? ModelPick(model: defaults?.model, level: defaults?.thinkingLevel ?? .off)
        return reconcileDraftPick(models: models, defaults: defaults, remembered: remembered)
    }

    func setDraftModel(_ ref: ModelRef) {
        let levels = summaryOf(models: snapshot?.models ?? [], model: ref)?.thinkingLevels ?? [.off]
        draftPick = ModelPick(model: ref, level: clampLevel(levels: levels, want: effectiveDraftPick.level))
    }

    func setDraftLevel(_ level: ThinkingLevel) {
        draftPick = ModelPick(model: effectiveDraftPick.model, level: level)
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
        let pick = effectiveDraftPick
        let checkout: ConversationCheckout? = {
            if case .project = draftHome, draftCheckout == .project { return .project }
            return nil
        }()
        creating = true
        defer { creating = false }
        do {
            _ = try await session.invoke(.createConversation(
                home: draftHome, text: text, checkout: checkout,
                model: pick.model, thinkingLevel: pick.level, agent: nil, images: tray.images))
        } catch {
            lastError = "新建对话失败：\(describe(error))"
            return
        }
        // The op resolves before its snapshot is published — wait for it.
        for _ in 0..<120 {
            if let shown = known.created(shown: snapshot?.conversation?.id) {
                drafts[key] = nil
                trays[key] = nil
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
            throw SessionError.operationFailed("宿主的回复不是目录列表")
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
            throw SessionError.operationFailed("宿主的回复不是文件列表")
        }
        return (files, truncated)
    }

    /// Register a folder as a project and make it the draft's home.
    func addProject(_ path: String) async throws {
        guard let session else { throw SessionError.sessionClosed }
        guard case .project(let project) = try await session.invoke(.addProject(path: path)) else {
            throw SessionError.operationFailed("宿主的回复不是项目")
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
        case SessionError.sessionClosed: "连接已关闭"
        default: error.localizedDescription
        }
    }
}
