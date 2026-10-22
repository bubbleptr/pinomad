import PinomadChat
import PinomadCore
import SwiftUI

/// The conversation overview (#267, the iOS form of the Web overview card):
/// where the conversation works, what it changed, and which subagents are
/// busy. The change stat and the pushed file list share one fetch, owned
/// here; everything else reads the snapshot.
struct OverviewSheet: View {
    let model: AppModel
    let conversationId: UInt64
    /// Opens a subagent in the main stack once the sheet is gone.
    let openSubagent: (UInt64) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var panel = ChangesPanel()
    @State private var path = NavigationPath()
    @State private var detent = PresentationDetent.medium

    private var snapshot: ClientSnapshot? { model.snapshot }

    private var conversation: ConversationSnapshot? {
        snapshot?.conversation.flatMap { $0.id == conversationId ? $0 : nil }
    }

    private var connected: Bool {
        guard let snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    private var busy: Bool { conversation?.busy ?? false }

    /// A chat has no repository to diff; the Web card skips the ask too.
    private var isChat: Bool { conversation?.home == .chat }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("概览")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            dismiss()
                        } label: {
                            Image(.x)
                        }
                        .accessibilityLabel("关闭")
                    }
                }
                .navigationDestination(for: OverviewPage.self) { _ in
                    ChangesList(
                        panel: panel,
                        worktree: conversation?.checkout != nil,
                        refresh: refresh,
                        load: { start(panel.load()) }
                    )
                }
                .navigationDestination(for: PatchFile.self) { file in
                    FileDiffView(file: file)
                }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        // A file list or a diff is cramped at half height.
        .onChange(of: path.count) { _, depth in
            if depth > 0 { detent = .large }
        }
        .task {
            guard !isChat else { return }
            start(panel.open(busy: busy, connected: connected))
        }
        .onChange(of: busy) { _, busy in
            start(panel.observe(busy: busy, connected: connected))
        }
        .onChange(of: connected) { _, connected in
            start(panel.observe(busy: busy, connected: connected))
        }
        // Attached to the stack, not its content: pushing a page must not
        // end the sheet's epoch, while dismissing the sheet must.
        .onDisappear { panel.close() }
    }

    @ViewBuilder
    private var content: some View {
        let workspace = self.workspace
        let subagents = snapshot.flatMap {
            SubagentOverview.of(organized: $0.organized, conversation: conversationId)
        }
        if workspace == nil && subagents == nil {
            ContentUnavailableView { Label("没有可显示的概览", image: .info) }
        } else {
            List {
                if let workspace {
                    Section("工作区") { workspaceRows(workspace) }
                }
                if let subagents {
                    Section("子代理") { subagentRows(subagents) }
                }
            }
        }
    }

    // MARK: Workspace

    private struct Workspace {
        let cwd: String?
        let worktree: Bool
        let home: Home?
        let branch: String?
        let showsChanges: Bool
    }

    /// What the workspace section shows, or nil when it has nothing.
    private var workspace: Workspace? {
        guard let conversation else { return nil }
        let workspace = Workspace(
            cwd: conversation.agent.cwd,
            worktree: conversation.checkout != nil,
            home: conversation.home,
            branch: workspaceBranch(
                hostMinor: snapshot?.host?.protocol.minor,
                changes: panel.changes,
                checkout: conversation.checkout
            ),
            showsChanges: !isChat && !isUnavailable
        )
        guard workspace.cwd != nil || workspace.branch != nil || workspace.showsChanges
        else { return nil }
        return workspace
    }

    @ViewBuilder
    private func workspaceRows(_ workspace: Workspace) -> some View {
        if let cwd = workspace.cwd {
            folderRow(cwd: cwd, worktree: workspace.worktree, home: workspace.home)
        }
        if let branch = workspace.branch {
            Label(branch, image: .gitBranch)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        if workspace.showsChanges {
            NavigationLink(value: OverviewPage.changes) {
                LabeledContent {
                    changeStat
                } label: {
                    Label("改动", image: .squareDiff)
                }
            }
        }
    }

    private func folderRow(cwd: String, worktree: Bool, home: Home?) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(folderName(cwd: cwd, home: home))
                        .lineLimit(1)
                    if worktree {
                        Text("worktree")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.secondary.opacity(0.14), in: Capsule())
                    }
                }
                Text(cwd)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    // The path's tail says where it is.
                    .truncationMode(.head)
            }
        } icon: {
            Image(worktree ? .folderGit2 : .folder)
        }
    }

    /// A worktree's own folder is named for the conversation, so a project
    /// conversation names the project; a chat's folder has nothing better.
    private func folderName(cwd: String, home: Home?) -> String {
        switch home {
        case .project(let path):
            let project = snapshot?.organized.projects.first { $0.project.path == path }?.project
            return project?.name ?? (path as NSString).lastPathComponent
        case .chat:
            return "对话文件夹"
        default:
            return (cwd as NSString).lastPathComponent
        }
    }

    /// No repository behind the conversation: the Web card hides the row,
    /// and so does the overview.
    private var isUnavailable: Bool {
        if case .unavailable? = panel.changes { return true }
        return false
    }

    @ViewBuilder
    private var changeStat: some View {
        switch panel.changes {
        case nil:
            Text(panel.error == nil ? "…" : "—")
                .foregroundStyle(.secondary)
        case .unavailable?:
            EmptyView()
        case .available(_, let files, let truncated, _)?:
            let additions = files.reduce(UInt64(0)) { $0 + $1.additions }
            let deletions = files.reduce(UInt64(0)) { $0 + $1.deletions }
            if files.isEmpty {
                Text("无")
                    .foregroundStyle(.secondary)
            } else if additions == 0 && deletions == 0 {
                // Binary edits, renames and mode changes touch files
                // without text lines.
                Text("\(files.count) 个文件")
                    .foregroundStyle(.secondary)
            } else {
                // A truncated patch undercounts: a trailing "+" marks the
                // numbers as a floor, as on the Web card.
                let floor = truncated ? "+" : ""
                HStack(spacing: 4) {
                    Text("+\(additions)\(floor)").foregroundStyle(.green)
                    Text("−\(deletions)\(floor)").foregroundStyle(.red)
                }
                .monospacedDigit()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "\(truncated ? "至少" : "")新增 \(additions) 行，删除 \(deletions) 行"
                )
            }
        }
    }

    // MARK: Subagents

    @ViewBuilder
    private func subagentRows(_ overview: SubagentOverview) -> some View {
        ForEach(overview.active) { row in
            Button {
                // The shown conversation is already open underneath.
                if row.id != conversationId { openSubagent(row.id) }
                dismiss()
            } label: {
                HStack(spacing: 10) {
                    Circle()
                        .fill(row.waiting ? Color.orange : Color.green)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(row.name)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    Text(row.waiting ? "等你回答" : (row.activity ?? "运行中"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Image(.chevronRight)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            // A row that pushes, not an action: keep the text unaccented.
            .tint(.primary)
        }
        let summary = [
            overview.moreRunning > 0 ? "还有 \(overview.moreRunning) 个运行中" : nil,
            overview.finished > 0 ? "\(overview.finished) 个已完成" : nil,
            overview.failed > 0 ? "\(overview.failed) 个失败" : nil,
        ].compactMap { $0 }
        if !summary.isEmpty {
            Text(summary.joined(separator: " · "))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Fetching

    private func refresh() async {
        guard let token = panel.refresh() else { return }
        await load(token)
    }

    private func start(_ token: ChangesPanel.Token?) {
        guard let token else { return }
        Task { await load(token) }
    }

    private func load(_ token: ChangesPanel.Token) async {
        do {
            let changes = try await model.changes(conversation: conversationId)
            panel.land(token, changes)
        } catch is CancellationError {
            // The sheet is going away; `close()` already ended the epoch.
        } catch {
            panel.fail(token, model.describe(error))
        }
    }
}

/// Pages the overview pushes inside its own stack.
private enum OverviewPage: Hashable {
    case changes
}
