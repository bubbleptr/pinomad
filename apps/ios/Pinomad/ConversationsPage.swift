import PinomadCore
import SwiftUI

/// One list of roots — a machine's Chats or project, or a status tile's
/// across every machine (nil host) — one row per family: forks and
/// subagents roll up into their root's status and recency rather than
/// getting rows of their own (the web sidebar's rule, via the core's family
/// derivations).
struct ConversationsPage: View {
    let model: AppModel
    let hostKey: String?
    let filter: ConversationFilter

    /// The row being renamed, its title when the alert opened, and the
    /// title being typed. The old title is kept here, not looked up again:
    /// the row may leave a status list while the alert is up.
    @State private var renaming: ConversationRef?
    @State private var renamingFrom = ""
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
            ForEach(rows) { entry in
                row(entry)
                    // The list ends without a rule under its last row.
                    .listRowSeparator(entry.id == rows.last?.id ? .hidden : .automatic, edges: .bottom)
            }
        }
        .listStyle(.plain)
        .overlay {
            if rows.isEmpty, loaded {
                if query.isEmpty {
                    ContentUnavailableView { Label(emptyTitle, image: filter.image) }
                } else {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
        // Kept for the back button's history menu, not drawn in the bar —
        // except as the slot "Connecting…" takes over.
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: model.showsReconnecting(hostKey) ? nil : .title)
        .searchable(text: $query, prompt: "Search conversations")
        .toolbar {
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("New", image: .squarePen) {
                    guard let draftHost else { return }
                    // A project's page starts the draft in it; Chats as a Chat.
                    if case .project(let path) = filter { model.runtimes[draftHost]?.draftHome = .project(path: path) }
                    if filter == .chats { model.runtimes[draftHost]?.draftHome = .chat }
                    model.navPath.append(.newConversation(hostKey: draftHost))
                }
                .disabled(!model.isConnected(draftHost ?? ""))
            }
        }
        .alert("Rename Conversation", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Name", text: $newTitle)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Save") { saveRename() }
        } message: {
            if let renameError { Text(renameError) }
        }
        .safeAreaInset(edge: .top) {
            if let hostKey { ConnectionBanner(model: model, hostKey: hostKey) }
        }
        .reconnectingTitle(model, hostKey: hostKey)
    }

    /// This machine's draft; a cross-machine list starts on the machine
    /// last shown, as the home page does.
    private var draftHost: String? { hostKey ?? model.currentHostKey }

    private var loaded: Bool {
        if let hostKey { return model.runtimes[hostKey]?.snapshot != nil }
        return model.machines.contains { model.runtimes[$0.hostKey]?.snapshot != nil }
    }

    private var organized: Organized? {
        hostKey.flatMap { model.runtimes[$0]?.snapshot?.organized }
    }

    private var rows: [MachineRoot] {
        let roots: [MachineRoot]
        if let hostKey {
            guard let organized else { return [] }
            switch filter {
            case .chats:
                roots = organized.chats.map { MachineRoot(hostKey: hostKey, node: $0, project: nil) }
            case .project(let path):
                roots = (organized.projects.first { $0.project.path == path }?.conversations ?? [])
                    .map { MachineRoot(hostKey: hostKey, node: $0, project: nil) }
            default:
                roots = allRoots(organized).map { MachineRoot(hostKey: hostKey, node: $0.node, project: $0.project) }
            }
        } else {
            roots = model.machineRoots
        }
        let filtered = filter.status.map { status in
            roots.filter { familyStatus(node: $0.node) == status }
        } ?? roots
        guard !query.isEmpty else { return filtered }
        return filtered.filter { displayName(summary: $0.node.summary).localizedCaseInsensitiveContains(query) }
    }

    /// A page mixing groups names each row's project (and machine).
    private var showsProject: Bool {
        switch filter {
        case .chats, .project: false
        default: true
        }
    }

    private var title: String {
        switch filter {
        case .project(let path):
            organized?.projects.first { $0.project.path == path }?.project.name ?? path
        default: filter.title
        }
    }

    private var emptyTitle: String {
        switch filter {
        case .needsAnswer: "No conversations need an answer"
        case .running: "No running conversations"
        case .failed: "No failed conversations"
        default: "No conversations yet"
        }
    }

    @ViewBuilder
    private func row(_ entry: MachineRoot) -> some View {
        let label = ConversationRowLabel(node: entry.node, project: showsProject ? model.rowSubtitle(entry) : nil)
        if let ref = entry.ref {
            NavigationLink(value: Route.conversation(ref)) { label }
                .quietSeparator()
                .contextMenu {
                    if model.hostSupports("renameConversation", on: ref.hostKey) {
                        Button("Rename", image: .pencil) {
                            newTitle = displayName(summary: entry.node.summary)
                            renamingFrom = newTitle
                            renameError = nil
                            renaming = ref
                        }
                    }
                    Button("Archive", image: .archive) { model.archive(ref, true) }
                }
                .swipeActions(edge: .trailing) {
                    Button("Archive", image: .archive) { model.archive(ref, true) }
                        .tint(.indigo)
                }
        } else {
            label
        }
    }

    /// Rename is request-class: a refusal comes back as the host's reason,
    /// shown in the alert, which stays up for another try.
    private func saveRename() {
        guard let ref = renaming else { return }
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != renamingFrom else {
            renaming = nil
            return
        }
        Task {
            do {
                try await model.rename(ref, to: title)
                renaming = nil
            } catch {
                renameError = model.describe(error)
                renaming = ref
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
                .accessibilityLabel("\(subagents) subagent\(subagents == 1 ? "" : "s")")
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
                    .accessibilityLabel(filter.status == nil ? "Unknown status" : filter.title)
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
        case .all: "All"
        case .needsAnswer: "Needs Answer"
        case .running: "Running"
        case .failed: "Failed"
        case .chats: "Chats"
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
