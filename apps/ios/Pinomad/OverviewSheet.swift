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
    /// Processes whose Stop is waiting for the host's answer; the row's
    /// button stays disabled until the call resolves.
    @State private var stopping: Set<String> = []
    /// Bound to the host that opened the sheet, so a focus change while it
    /// is up cannot send the unwatch to another host.
    @State private var processWatch = ProcessWatchSession()
    /// Whether Subagents lists every row or folds the rest behind "Show all".
    @State private var showAllSubagents = false

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

    /// The family root whose process list the overview watches, even while
    /// a fork is shown (ADR-0045 §3).
    private var processRoot: UInt64? {
        snapshot.flatMap { rootOf(organized: $0.organized, id: conversationId)?.summary.id }
    }

    private var processes: ProcessesOverview? {
        snapshot.flatMap {
            ProcessesOverview.of(
                organized: $0.organized, conversation: conversationId, processes: $0.processes)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Overview")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            dismiss()
                        } label: {
                            Image(.x)
                        }
                        .accessibilityLabel("Close")
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
            #if DEBUG
            if ProcessInfo.processInfo.environment["PINOMAD_OPEN_OVERVIEW"] == "large" { detent = .large }
            #endif
            guard !isChat else { return }
            start(panel.open(busy: busy, connected: connected))
        }
        // The list belongs to the family root; the watch starts as soon as
        // the organized index names it and survives reconnects in the core.
        // It stays bound to this host even if focus moves elsewhere.
        .task(id: processRoot) {
            guard let root = processRoot else {
                processWatch.close()
                return
            }
            processWatch.open(root: root, on: model.focusedRuntime)
        }
        .onChange(of: busy) { _, busy in
            start(panel.observe(busy: busy, connected: connected))
        }
        .onChange(of: connected) { _, connected in
            start(panel.observe(busy: busy, connected: connected))
        }
        // Attached to the stack, not its content: pushing a page must not
        // end the sheet's epoch, while dismissing the sheet must.
        .onDisappear {
            panel.close()
            processWatch.close()
        }
        .hostsToasts(model)
    }

    @ViewBuilder
    private var content: some View {
        let workspace = self.workspace
        let subagents = snapshot.flatMap {
            SubagentOverview.of(organized: $0.organized, conversation: conversationId)
        }
        let processes = self.processes
        if conversation == nil && workspace == nil && subagents == nil && processes == nil {
            ContentUnavailableView { Label("No overview to show", image: .info) }
        } else {
            List {
                if let conversation {
                    Section("Context") {
                        let breakdown = ContextBreakdownReading(
                            conversation.contextUsage, breakdown: conversation.contextBreakdown
                        )
                        contextRow(ContextMeterReading(conversation.contextUsage), breakdown: breakdown)
                        breakdownRows(breakdown)
                    }
                }
                if let workspace {
                    Section("Workspace") { workspaceRows(workspace) }
                }
                if let subagents {
                    Section("Subagents") { subagentRows(subagents) }
                }
                if let processes {
                    Section {
                        processRows(processes)
                    } header: {
                        Text("Processes")
                    } footer: {
                        Text(ProcessesOverview.footer)
                    }
                }
            }
        }
    }

    // MARK: Context

    /// How full the model's window is: the percent and figures, orange once
    /// it nears compaction, over the grid (one colour per part when the host
    /// sent a breakdown of the reply the meter counts).
    private func contextRow(_ reading: ContextMeterReading, breakdown: ContextBreakdownReading) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // The section header already says "Context": the row leads with
            // the figures, as the Web card's headline does.
            HStack(alignment: .firstTextBaseline) {
                Text(reading.figures)
                    .foregroundStyle(reading.percent == nil ? .secondary : .primary)
                    .rollingNumber(reading.figures)
                Spacer(minLength: 12)
                if let percent = reading.percent {
                    Text("\(percent)%")
                        .foregroundStyle(reading.warning ? Color(uiColor: .systemOrange) : .secondary)
                        .rollingNumber(percent)
                }
            }
            .monospacedDigit()
            ContextGrid(meter: reading, breakdown: breakdown)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(reading.accessibilityLabel)
    }

    /// The grid legend: a row per part that takes space with its tokens,
    /// then what is left of the window.
    private func breakdownRows(_ reading: ContextBreakdownReading) -> some View {
        ForEach(reading.rows) { row in
            LabeledContent {
                Text(row.figure)
                    .monospacedDigit()
            } label: {
                Label {
                    Text(row.label)
                } icon: {
                    ContextBreakdownSwatch(color: row.part?.color ?? ContextGrid.emptyColor)
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
            showsChanges: !isChat && workspaceHasChanges(panel.changes)
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
                    Label("Changes", image: .squareDiff)
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
                Text(workspaceFolderPath(cwd: cwd, home: home))
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
            return "Chat folder"
        default:
            return (cwd as NSString).lastPathComponent
        }
    }

    /// The row only shows once the checkout has files (`workspaceHasChanges`).
    @ViewBuilder
    private var changeStat: some View {
        if case .available(_, let files, let truncated, _)? = panel.changes {
            let additions = files.reduce(UInt64(0)) { $0 + $1.additions }
            let deletions = files.reduce(UInt64(0)) { $0 + $1.deletions }
            if additions == 0 && deletions == 0 {
                // Binary edits, renames and mode changes touch files
                // without text lines.
                Text("\(files.count) file\(files.count == 1 ? "" : "s")")
                    .foregroundStyle(.secondary)
            } else {
                // A truncated patch undercounts: a trailing "+" marks the
                // numbers as a floor, as on the Web card.
                let floor = truncated ? "+" : ""
                HStack(spacing: 4) {
                    Text("+\(additions)\(floor)").foregroundStyle(.green).rollingNumber(additions)
                    Text("−\(deletions)\(floor)").foregroundStyle(.red).rollingNumber(deletions)
                }
                .monospacedDigit()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "\(truncated ? "At least " : "")\(additions) added, \(deletions) removed"
                )
            }
        }
    }

    // MARK: Subagents

    /// Every subagent, at work first; past `listed` they fold behind
    /// "Show all", since the sheet is the only list of them on iOS.
    @ViewBuilder
    private func subagentRows(_ overview: SubagentOverview) -> some View {
        let shown = showAllSubagents ? overview.rows : Array(overview.rows.prefix(overview.listed))
        ForEach(shown) { row in
            Button {
                // The shown conversation is already open underneath.
                if row.id != conversationId { openSubagent(row.id) }
                dismiss()
            } label: {
                HStack(spacing: 10) {
                    TaskIcon(kind: .subagent, tone: row.tone)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name)
                            .lineLimit(1)
                            .foregroundStyle(.primary)
                        Text(row.state)
                            .font(.footnote)
                            .foregroundStyle(row.tone == .failed ? Color.red : Color.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Image(.chevronRight)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Subagent, \(row.name), \(row.state)")
            }
            // A row that pushes, not an action: keep the text unaccented.
            .tint(.primary)
        }
        if overview.rows.count > overview.listed {
            Button(showAllSubagents ? "Show fewer" : "Show all \(overview.rows.count)") {
                withAnimation(.snappy) { showAllSubagents.toggle() }
            }
        }
    }

    // MARK: Processes

    @ViewBuilder
    private func processRows(_ overview: ProcessesOverview) -> some View {
        ForEach(overview.rows) { row in
            HStack(spacing: 10) {
                TaskIcon(kind: .process, tone: row.tone)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .lineLimit(1)
                    HStack(spacing: 0) {
                        Text(row.state)
                            .foregroundStyle(row.tone == .failed ? Color.red : Color.secondary)
                        if let command = row.command {
                            Text(" · ").foregroundStyle(.secondary)
                            Text(command)
                                .monospaced()
                                .foregroundStyle(.secondary)
                                .truncationMode(.middle)
                        }
                    }
                    .font(.footnote)
                    .lineLimit(1)
                }
                // The visible result is short; VoiceOver reads the long
                // state line, including a lost process's old pid. Keep this
                // on the text block so the Stop button stays reachable.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(processLabel(row))
                Spacer(minLength: 8)
                if row.active {
                    // The running duration ticks like the Web list's clock.
                    // A startedAt the clock can't represent hides it.
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let elapsed = processElapsedText(
                            ms: context.date.timeIntervalSince(row.startedAt) * 1000)
                        if !elapsed.isEmpty {
                            Text(elapsed)
                                .font(.footnote)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                        }
                    }
                }
                if row.canStop {
                    Button("Stop") { stop(row) }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.borderless)
                        .disabled(stopping.contains(row.id))
                }
            }
        }
        let summary = [
            overview.moreRunning > 0 ? "\(overview.moreRunning) more running" : nil,
            overview.moreEnded > 0 ? "\(overview.moreEnded) more ended" : nil,
        ].compactMap { $0 }
        if !summary.isEmpty {
            Text(summary.joined(separator: " · "))
                .foregroundStyle(.secondary)
        }
    }

    private func processLabel(_ row: ProcessesOverview.Row) -> String {
        let command = row.command.map { ", \($0)" } ?? ""
        return "Process, \(row.name)\(command). \(row.status)"
    }

    /// Stop is one tap and no confirmation; the row disables while its call
    /// waits for the host's answer.
    private func stop(_ row: ProcessesOverview.Row) {
        guard let root = processRoot, !stopping.contains(row.id) else { return }
        stopping.insert(row.id)
        model.clearToast(key: "stop-process")
        Task {
            do {
                try await model.stopProcess(root: root, id: row.id)
            } catch {
                model.showToast(
                    "Couldn't stop the process: \(model.describe(error))", level: .error, key: "stop-process")
            }
            stopping.remove(row.id)
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

/// A task row's icon: a robot for a subagent, a terminal for a background
/// process, green while at work, red once failed, grey when over. Rows say
/// the state in words too, so color is never the only signal.
private struct TaskIcon: View {
    enum Kind { case subagent, process }
    let kind: Kind
    let tone: TaskTone

    var body: some View {
        Image(kind == .subagent ? .bot : .squareTerminal)
            .foregroundStyle(color)
            .frame(width: 20)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch tone {
        case .running: .green
        case .failed: .red
        case .done: .secondary
        }
    }
}

/// Pages the overview pushes inside its own stack.
private enum OverviewPage: Hashable {
    case changes
}
