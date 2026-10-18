import PinomadCore
import SwiftUI

/// The organized conversation list: chats and project groups as the host
/// sends them, one row per family root — forks and subagents roll up into
/// their root's status and recency rather than getting rows of their own
/// (the web sidebar's rule, via the core's family derivations).
struct ConversationListView: View {
    let model: AppModel

    /// The row being renamed, and the title being typed.
    @State private var renaming: ConversationSummary?
    @State private var newTitle = ""
    @State private var renameError: String?

    var body: some View {
        List {
            if !model.lastError.isEmpty {
                // Platform failures (e.g. the keychain rejecting a pairing
                // write) are not fatal to the connection, but must be
                // visible — a toast would lose them.
                Label(model.lastError, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let organized = model.snapshot?.organized {
                if !organized.chats.isEmpty {
                    Section("对话") {
                        ForEach(organized.chats, id: \.summary.id) { row($0) }
                    }
                }
                ForEach(Array(organized.projects.enumerated()), id: \.offset) { _, group in
                    Section(group.project.name ?? group.project.path ?? "项目") {
                        ForEach(group.conversations, id: \.summary.id) { row($0) }
                    }
                }
                if organized.chats.isEmpty && organized.projects.isEmpty {
                    ContentUnavailableView("还没有对话", systemImage: "bubble.left.and.bubble.right",
                                           description: Text("点右上角的新建开始一个。"))
                }
                if !organized.archived.isEmpty {
                    Section("已归档") {
                        ForEach(Array(organized.archived.enumerated()), id: \.offset) { _, entry in
                            archivedRow(entry)
                        }
                    }
                }
            } else {
                ProgressView("正在同步…")
            }
        }
        .navigationDestination(for: Route.self) { route in
            switch route {
            case .conversation(let id): ConversationView(model: model, conversationId: id)
            case .newConversation: NewConversationView(model: model)
            case .addProject: AddProjectView(model: model)
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("新建", systemImage: "square.and.pencil") {
                    model.navPath.append(.newConversation)
                }
                .disabled(!model.connected)
            }
            ToolbarItem(placement: .topBarLeading) {
                // The host on screen; opens the list to switch, forget or
                // pair another.
                Button {
                    model.present(.hosts)
                } label: {
                    HStack(spacing: 4) {
                        Text(model.currentHostLabel ?? "宿主")
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                    }
                    .font(.subheadline)
                }
                .accessibilityLabel("宿主：\(model.currentHostLabel ?? "")")
            }
        }
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model) }
    }

    @ViewBuilder
    private func row(_ node: ConversationNode) -> some View {
        let summary = node.summary
        if let id = summary.id {
            NavigationLink(value: Route.conversation(id)) {
                rowLabel(node)
            }
            .contextMenu {
                if model.hostSupports("renameConversation") {
                    Button("重命名", systemImage: "pencil") {
                        newTitle = displayName(summary: summary)
                        renameError = nil
                        renaming = summary
                    }
                }
                Button("归档", systemImage: "archivebox") { model.archive(conversation: id, true) }
            }
            .swipeActions(edge: .trailing) {
                Button("归档", systemImage: "archivebox") { model.archive(conversation: id, true) }
                    .tint(.indigo)
            }
        } else {
            rowLabel(node)
        }
    }

    /// Archived roots can't be opened from here; they can be restored.
    private func archivedRow(_ entry: ArchivedConversation) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName(summary: entry.node.summary)).lineLimit(1)
                if let name = entry.project?.name ?? entry.project?.path {
                    Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if let id = entry.node.summary.id {
                Button("恢复") { model.archive(conversation: id, false) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(!model.connected)
            }
        }
        .foregroundStyle(.secondary)
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

    private func rowLabel(_ node: ConversationNode) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName(summary: node.summary))
                    .lineLimit(1)
                if let status = familyStatus(node: node) {
                    Text(statusText(status))
                        .font(.caption)
                        .foregroundStyle(statusColor(status))
                }
            }
            Spacer()
            if let at = familyUpdatedAt(node: node) {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(relativeTime(at: at, now: context.date.timeIntervalSince1970 * 1000))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func statusText(_ status: ConversationStatus) -> String {
        switch status {
        case .needsAnswer: "需要回复"
        case .running: "运行中"
        case .failed: "失败"
        case .other(let raw): raw
        }
    }

    private func statusColor(_ status: ConversationStatus) -> Color {
        switch status {
        case .needsAnswer: .orange
        case .running: .green
        case .failed: .red
        case .other: .secondary
        }
    }
}
