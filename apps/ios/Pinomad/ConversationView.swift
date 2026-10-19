import AgentChatCore
import AgentChatKit
import PinomadChat
import PinomadCore
import SwiftUI

/// The shown conversation, read-only: entries render through AgentChatKit
/// — user bubbles, the run's trace, the answer's streaming markdown —
/// while `PinomadSession` keeps the snapshot current. Rows are equatable
/// keyed by the core's stable entry ids so a new version re-renders only
/// what actually changed.
struct ConversationView: View {
    let model: AppModel
    let conversationId: UInt64

    @State private var showingChanges = false

    private var conversation: ConversationSnapshot? {
        model.snapshot?.conversation.flatMap { $0.id == conversationId ? $0 : nil }
    }

    /// The shown conversation's node in the organized tree — its children
    /// are the subagents its runs can show as cards.
    private var node: ConversationNode? {
        guard let organized = model.snapshot?.organized
        else { return nil }
        return findConversation(organized: organized, id: conversationId)
    }

    var body: some View {
        // Read the node once per version: the title, role, retry rule and
        // card facts all derive from it.
        let node = self.node
        let title = node.map { displayName(summary: $0.summary) } ?? "对话"
        let role = node?.summary.role
        let isSubagent = node?.summary.kind == .subagent
        // Card facts only, so a summary's churn (updatedAt/status/activity)
        // doesn't invalidate the transcript's rows.
        let subagentSummaries = ChatAdapter.subagentSummaries(in: node)
        Group {
            if let conversation {
                if autoScroll {
                    // Debug-only: a scripted scroll drives the transcript
                    // so PerfLog can measure hitches while scrolling —
                    // a remote runner has no way to drag a finger.
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 24) {
                                entries(conversation, subagentSummaries: subagentSummaries, isSubagent: isSubagent)
                                Color.clear.frame(height: 1).id("bottom")
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                        }
                        .defaultScrollAnchor(.bottom)
                        .task {
                            while !Task.isCancelled {
                                proxy.scrollTo("bottom", anchor: .bottom)
                                try? await Task.sleep(for: .milliseconds(120))
                            }
                        }
                    }
                } else {
                    Transcript(pin: model.transcriptPin) {
                        entries(conversation, subagentSummaries: subagentSummaries, isSubagent: isSubagent)
                    }
                }
            } else {
                ProgressView("正在载入对话…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .environment(\.inlineImageAction, InlineImageAction { image in
            model.viewing = MessageImage(data: image.data, mimeType: image.mimeType)
        })
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model) }
        .safeAreaInset(edge: .bottom) {
            if let conversation {
                ConversationComposer(model: model, conversation: conversation)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .conversationRoleSubtitle(role)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingChanges = true
                } label: {
                    Image(systemName: "plus.forwardslash.minus")
                }
                .accessibilityLabel("改动")
                .disabled(!connected)
            }
        }
        .sheet(isPresented: $showingChanges) {
            ChangesSheet(model: model, conversationId: conversationId)
        }
        .task { model.openConversation(conversationId) }
    }

    /// Scripted scrolling for perf runs, driven by `PINOMAD_AUTOSCROLL` in
    /// Debug builds only; Release always renders the real transcript.
    private var autoScroll: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["PINOMAD_AUTOSCROLL"] != nil
        #else
        return false
        #endif
    }

    private var connected: Bool {
        guard let snapshot = model.snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    private static func endsInFailure(_ chat: [ChatEntry]) -> Bool {
        if case .run(_, _, _, _, let failure)? = chat.last { return failure != nil }
        return false
    }

    @ViewBuilder
    private func entries(
        _ conversation: ConversationSnapshot,
        subagentSummaries: [UInt64: SubagentCardSummary],
        isSubagent: Bool
    ) -> some View {
        // A subagent's run belongs to the delegating task; retryOf only
        // answers when the newest entry is a failed run — check that here
        // first: the call copies the whole history across the FFI, which
        // every streaming snapshot would otherwise pay for.
        let retry = connected && !isSubagent && Self.endsInFailure(conversation.chat)
            ? retryOf(entries: conversation.chat) : nil
        ForEach(conversation.chat, id: \.entryId) { entry in
            row(entry, retry: entry.entryId == conversation.chat.last?.entryId ? retry : nil,
                subagentSummaries: subagentSummaries)
        }
    }

    @ViewBuilder
    private func row(
        _ entry: ChatEntry,
        retry: RetryRequest?,
        subagentSummaries: [UInt64: SubagentCardSummary]
    ) -> some View {
        switch entry {
        case let .user(_, text, images):
            UserRow(text: text, images: images).equatable()
        case let .run(id, cot, _, interrupted, failure):
            RunRow(cot: cot, subagentSummaries: subagentSummaries,
                   interrupted: interrupted, failure: failure, stream: model.streamFor(id),
                   retry: retry.map { request in { model.retry(request, conversation: conversationId) } },
                   retryKey: retry?.requestId).equatable()
        case .compaction:
            MarkerRow("上下文已压缩")
        case .reset:
            MarkerRow("对话已重置")
        }
    }
}

private extension View {
    /// An empty subtitle would still reserve a line under the title.
    @ViewBuilder
    func conversationRoleSubtitle(_ role: String?) -> some View {
        if let role {
            navigationSubtitle("@\(role)")
        } else {
            self
        }
    }
}

/// What the user sent: the bubble, then any attached images.
private struct UserRow: View, Equatable {
    let text: String
    let images: [MessageImage]

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !text.isEmpty { UserMessageView(text) }
            ForEach(images, id: \.data) { image in
                InlineImage(ToolImage(data: image.data, mimeType: image.mimeType), maxWidth: 240, maxHeight: 200)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.images == rhs.images
    }
}

/// One run: the trace header/steps, the answer as it streams or settled,
/// and the failure line a dead run leaves behind.
private struct RunRow: View, Equatable {
    let cot: CotView
    /// Supplies the subagent cards' call-given labels and roles; only the
    /// fields the cards show, so summary churn doesn't invalidate the row.
    let subagentSummaries: [UInt64: SubagentCardSummary]
    let interrupted: Bool
    let failure: String?
    let stream: StreamingMarkdown?
    /// Set on the newest failed run while a retry is possible.
    let retry: (() -> Void)?
    /// What `retry` resends — the closure itself can't be compared.
    let retryKey: String?

    var body: some View {
        // Split only when this row's body runs — `.equatable()` skips it
        // for unchanged runs, and the core call has a no-subagent fast path.
        let split = ChatAdapter.splitRun(cot, summaries: subagentSummaries)
        VStack(alignment: .leading, spacing: 8) {
            AgentTraceView(ChatAdapter.trace(cot: split.trace, interrupted: interrupted))
            ForEach(split.cards) { card in
                SubagentCardView(card: card)
            }
            if cot.answer != nil {
                ReplyBody(answer: cot.answer!, stream: stream)
            }
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            if let retry {
                Button("重试", systemImage: "arrow.clockwise", action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.cot == rhs.cot && lhs.subagentSummaries == rhs.subagentSummaries
            && lhs.interrupted == rhs.interrupted && lhs.failure == rhs.failure
            && lhs.stream === rhs.stream && lhs.retryKey == rhs.retryKey
    }
}

/// Snapshot-only markers between entries.
private struct MarkerRow: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
    }
}

/// A run's answer. The stream is owned by the model (snapshot-driven sync)
/// — the view only reads it, so nothing in a lazy row mutates state.
private struct ReplyBody: View {
    let answer: CotAnswer
    let stream: StreamingMarkdown?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let stream {
                StreamingMarkdownView(stream)
                if stream.stream.isFinished {
                    ReplyActions(markdown: stream.markdown)
                }
            }
        }
    }
}
