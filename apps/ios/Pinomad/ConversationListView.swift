import PinomadCore
import SwiftUI

/// The organized conversation list: chats and project groups as the host
/// sends them, one row per family root — forks and subagents roll up into
/// their root's status and recency rather than getting rows of their own
/// (the web sidebar's rule, via the core's family derivations).
struct ConversationListView: View {
    let model: AppModel

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
                    ContentUnavailableView("还没有对话", systemImage: "bubble.left.and.bubble.right")
                }
            } else {
                ProgressView("正在同步…")
            }
        }
        .navigationDestination(for: UInt64.self) { id in
            ConversationView(model: model, conversationId: id)
        }
        .toolbar {
            if model.connectionText != "已连接" {
                ToolbarItem(placement: .topBarTrailing) {
                    Text(model.connectionText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ node: ConversationNode) -> some View {
        let summary = node.summary
        if let id = summary.id {
            NavigationLink(value: id) {
                rowLabel(node)
            }
        } else {
            rowLabel(node)
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
