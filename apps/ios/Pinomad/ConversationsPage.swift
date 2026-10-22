import PinomadCore
import SwiftUI

/// One list of the machine's roots — a status tile's, Chats, or a project —
/// one row per family: forks and subagents roll up into their root's status
/// and recency rather than getting rows of their own (the web sidebar's
/// rule, via the core's family derivations).
struct ConversationsPage: View {
    let model: AppModel
    let filter: ConversationFilter

    /// The row being renamed, and the title being typed.
    @State private var renaming: ConversationSummary?
    @State private var newTitle = ""
    @State private var renameError: String?
    @State private var query = ""

    var body: some View {
        let rows = self.rows
        List {
            // The title sits below the bar, leading, smaller than a large
            // title: the bar's trailing edge stays free for page actions.
            Text(title)
                .font(.title2.bold())
                .lineLimit(1)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 8, trailing: 20))
                .accessibilityAddTraits(.isHeader)
            ForEach(rows, id: \.node.summary.id) { entry in
                row(entry.node, project: showsProject ? entry.project : nil)
                    // The list ends without a rule under its last row.
                    .listRowSeparator(
                        entry.node.summary.id == rows.last?.node.summary.id ? .hidden : .automatic,
                        edges: .bottom
                    )
            }
        }
        .listStyle(.plain)
        .overlay {
            if rows.isEmpty, model.snapshot?.organized != nil {
                if query.isEmpty {
                    ContentUnavailableView { Label(emptyTitle, image: filter.image) }
                } else {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
        // Kept for the back button's history menu, not drawn in the bar.
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        .searchable(text: $query, prompt: "搜索对话")
        .toolbar {
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("新建", image: .squarePen) {
                    // A project's page starts the draft in it; Chats as a Chat.
                    if case .project(let path) = filter { model.draftHome = .project(path: path) }
                    if filter == .chats { model.draftHome = .chat }
                    model.navPath.append(.newConversation)
                }
                .disabled(!model.connected)
            }
        }
        .alert("重命名对话", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("名称", text: $newTitle)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") { saveRename() }
        } message: {
            if let renameError { Text(renameError) }
        }
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model) }
    }

    private var rows: [(node: ConversationNode, project: String?)] {
        guard let organized = model.snapshot?.organized else { return [] }
        let roots: [(node: ConversationNode, project: String?)]
        switch filter {
        case .all: roots = allRoots(organized)
        case .needsAnswer, .running, .failed:
            roots = allRoots(organized).filter { familyStatus(node: $0.node) == filter.status }
        case .chats: roots = organized.chats.map { ($0, nil) }
        case .project(let path):
            roots = organized.projects.first { $0.project.path == path }?
                .conversations.map { ($0, nil) } ?? []
        }
        guard !query.isEmpty else { return roots }
        return roots.filter { displayName(summary: $0.node.summary).localizedCaseInsensitiveContains(query) }
    }

    /// A page mixing groups names each row's project.
    private var showsProject: Bool {
        switch filter {
        case .chats, .project: false
        default: true
        }
    }

    private var title: String {
        switch filter {
        case .project(let path):
            model.snapshot?.organized.projects.first { $0.project.path == path }?.project.name ?? path
        default: filter.title
        }
    }

    private var emptyTitle: String {
        switch filter {
        case .needsAnswer: "没有需要回复的对话"
        case .running: "没有运行中的对话"
        case .failed: "没有失败的对话"
        default: "还没有对话"
        }
    }

    @ViewBuilder
    private func row(_ node: ConversationNode, project: String?) -> some View {
        let summary = node.summary
        if let id = summary.id {
            NavigationLink(value: Route.conversation(id)) {
                ConversationRowLabel(node: node, project: project)
            }
            .quietSeparator()
            .contextMenu {
                if model.hostSupports("renameConversation") {
                    Button("重命名", image: .pencil) {
                        newTitle = displayName(summary: summary)
                        renameError = nil
                        renaming = summary
                    }
                }
                Button("归档", image: .archive) { model.archive(conversation: id, true) }
            }
            .swipeActions(edge: .trailing) {
                Button("归档", image: .archive) { model.archive(conversation: id, true) }
                    .tint(.indigo)
            }
        } else {
            ConversationRowLabel(node: node, project: project)
        }
    }

    /// Rename is request-class: a refusal comes back as the host's reason,
    /// shown in the alert, which stays up for another try.
    private func saveRename() {
        guard let summary = renaming, let id = summary.id else { return }
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != displayName(summary: summary) else {
            renaming = nil
            return
        }
        Task {
            do {
                try await model.rename(conversation: id, to: title)
                renaming = nil
            } catch {
                renameError = model.describe(error)
                renaming = summary
            }
        }
    }
}

/// A root's row: the family's status as a leading dot (an empty slot when
/// idle), the title, the project when the page mixes groups, then the
/// subagent count. No recency: the order already says it, as in the web
/// sidebar. The line under the title is where the checkout's git state
/// will go.
struct ConversationRowLabel: View {
    let node: ConversationNode
    let project: String?

    var body: some View {
        let status = familyStatus(node: node)
        HStack(spacing: 12) {
            FamilyStatusDot(status: status)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName(summary: node.summary))
                    .lineLimit(1)
                if let project {
                    Text(project)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            let subagents = taskGroupsOf(root: node).reduce(0) { $0 + $1.tasks.count }
            if subagents > 0 {
                HStack(spacing: 2) {
                    Image(.users)
                    Text("\(subagents)").monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(subagents) 个子代理")
            }
        }
        .padding(.vertical, 4)
        .shortSeparator()
    }
}

/// The family's status as a small dot — green and breathing while running,
/// orange when it needs an answer, red when it failed — and an empty slot
/// of the same width when idle, so titles line up.
private struct FamilyStatusDot: View {
    let status: ConversationStatus?

    var body: some View {
        Group {
            if let status {
                let filter = ConversationFilter(status: status)
                Circle()
                    .fill(filter.status == nil ? Color.secondary : filter.tint)
                    .frame(width: 8, height: 8)
                    .phaseAnimator(status == .running ? [1.0, 0.35] : [1.0]) { dot, opacity in
                        dot.opacity(opacity)
                    } animation: { _ in .easeInOut(duration: 1.2) }
                    .accessibilityLabel(filter.status == nil ? "状态未知" : filter.title)
            } else {
                Color.clear
            }
        }
        .frame(width: 8, height: 8)
    }
}

extension View {
    /// Ends a row's separator short of the chevron. Applied to the row's
    /// content, whose trailing edge is where the chevron begins.
    func shortSeparator() -> some View {
        alignmentGuide(.listRowSeparatorTrailing) { $0[.trailing] - 12 }
    }

    /// A fainter separator than the system's, for lists of plain rows.
    func quietSeparator() -> some View {
        listRowSeparatorTint(Color.primary.opacity(0.07))
    }
}

extension ConversationFilter {
    init(status: ConversationStatus) {
        switch status {
        case .needsAnswer: self = .needsAnswer
        case .running: self = .running
        case .failed: self = .failed
        case .other: self = .all
        }
    }

    var status: ConversationStatus? {
        switch self {
        case .needsAnswer: .needsAnswer
        case .running: .running
        case .failed: .failed
        default: nil
        }
    }

    var title: String {
        switch self {
        case .all: "全部"
        case .needsAnswer: "需要回复"
        case .running: "运行中"
        case .failed: "失败"
        case .chats: "对话"
        case .project(let path): path
        }
    }

    var image: ImageResource {
        switch self {
        case .all: .inbox
        case .needsAnswer: .bellCheck
        case .running: .circleDashed
        case .failed: .ban
        case .chats: .messageCircle
        case .project: .folder
        }
    }

    var tint: Color {
        switch self {
        case .all: .indigo
        case .needsAnswer: .orange
        case .running: .green
        case .failed: .red
        case .chats, .project: .secondary
        }
    }
}
