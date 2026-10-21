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
    /// Whether the transcript is following its end. Captured when a card
    /// pushes a child so returning at the end keeps following the stream.
    @State private var transcriptAtBottom = true
    /// The run whose card pushed the child; returning reveals it once.
    @State private var subagentReturnItem: String?
    /// Whether the reader was at the end when the card pushed the child.
    @State private var subagentReturnAtBottom = true
    /// The run whose steps the trace sheet shows. Presented here rather
    /// than from the row: a lazy row can be recycled while the sheet is up,
    /// and the sheet reads the run from each new snapshot to stay live.
    @State private var tracedRun: TracedRun?

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
        let skillNames = self.skillNames
        Group {
            if let conversation {
                if autoScroll {
                    // Debug-only: a scripted scroll drives the transcript
                    // so PerfLog can measure hitches while scrolling —
                    // a remote runner has no way to drag a finger.
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 24) {
                                entries(conversation, subagentSummaries: subagentSummaries,
                                        skillNames: skillNames, isSubagent: isSubagent)
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
                    Transcript(
                        pin: model.transcriptPin,
                        restoreItemID: subagentReturnAtBottom ? nil : subagentReturnItem,
                        onBottomChange: { transcriptAtBottom = $0 }
                    ) {
                        entries(conversation, subagentSummaries: subagentSummaries,
                                skillNames: skillNames, isSubagent: isSubagent)
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
            if isSubagent {
                // A subagent belongs to its delegating task; the reader only
                // observes it. No composer, so nothing here can submit,
                // stop, compact, or change its model.
                Text("子代理的对话只能查看")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            } else if let conversation {
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
        .sheet(item: $tracedRun) { run in
            if let conversation {
                // The transcript's image action does not reach into a sheet,
                // and the root's viewer cannot present over one: the sheet
                // brings its own.
                ImageViewerHost {
                    traceSheet(run.id, in: conversation, subagentSummaries: subagentSummaries)
                }
            }
        }
        .task {
            model.openConversation(conversationId)
            model.requestSkills(for: skillScope)
        }
        .onChange(of: model.connected) { _, connected in
            if connected { model.requestSkills(for: skillScope, force: true) }
        }
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

    /// The bubble's skill names come from the conversation's own scope, not
    /// from whether a particular message used the menu.
    private var skillScope: SkillScope? {
        model.conversationSkillScope(conversationId)
    }

    private var skillNames: [String]? { model.skillNames(for: skillScope) }

    /// Record where to return before the session switches to the child. The
    /// tapped card's run is a stable anchor; a reader at the end keeps
    /// following the parent's stream instead.
    private func openSubagent(_ child: UInt64, from run: String) {
        subagentReturnItem = run
        subagentReturnAtBottom = transcriptAtBottom
        model.navPath.append(.conversation(child))
    }

    /// The newest run: the todo line ends it and no other. Not simply the
    /// last entry — a queued message can follow it.
    private static func latestRunId(_ chat: [ChatEntry]) -> String? {
        chat.last { if case .run = $0 { true } else { false } }?.entryId
    }

    private static func todoLine(_ conversation: ConversationSnapshot) -> TodoLine? {
        TodoLine(
            list: ChatAdapter.todo(conversation.todo),
            runWrites: ChatAdapter.todoWrites(in: conversation.chat)
        )
    }

    @ViewBuilder
    private func traceSheet(
        _ runId: String,
        in conversation: ConversationSnapshot,
        subagentSummaries: [UInt64: SubagentCardSummary]
    ) -> some View {
        if let entry = conversation.chat.first(where: { $0.entryId == runId }),
           case let .run(_, cot, _, interrupted, _) = entry {
            // The same trace the capsule summarizes: subagent calls stay
            // on their cards in the transcript.
            let trace = ChatAdapter.trace(
                cot: ChatAdapter.splitRun(cot, summaries: subagentSummaries).trace,
                interrupted: interrupted
            )
            AgentTraceSheet(
                trace,
                todo: runId == Self.latestRunId(conversation.chat) ? Self.todoLine(conversation) : nil
            )
        }
    }

    private static func endsInFailure(_ chat: [ChatEntry]) -> Bool {
        if case .run(_, _, _, _, let failure)? = chat.last { return failure != nil }
        return false
    }

    @ViewBuilder
    private func entries(
        _ conversation: ConversationSnapshot,
        subagentSummaries: [UInt64: SubagentCardSummary],
        skillNames: [String]?,
        isSubagent: Bool
    ) -> some View {
        // A subagent's run belongs to the delegating task; retryOf only
        // answers when the newest entry is a failed run — check that here
        // first: the call copies the whole history across the FFI, which
        // every streaming snapshot would otherwise pay for.
        let retry = connected && !isSubagent && Self.endsInFailure(conversation.chat)
            ? retryOf(entries: conversation.chat) : nil
        let latestRun = Self.latestRunId(conversation.chat)
        let todo = Self.todoLine(conversation)
        ForEach(conversation.chat, id: \.entryId) { entry in
            row(entry, retry: entry.entryId == conversation.chat.last?.entryId ? retry : nil,
                subagentSummaries: subagentSummaries, skillNames: skillNames,
                todo: entry.entryId == latestRun ? todo : nil)
        }
    }

    @ViewBuilder
    private func row(
        _ entry: ChatEntry,
        retry: RetryRequest?,
        subagentSummaries: [UInt64: SubagentCardSummary],
        skillNames: [String]?,
        todo: TodoLine?
    ) -> some View {
        switch entry {
        case let .user(_, text, images):
            UserRow(text: text, images: images, skillNames: skillNames).equatable()
        case let .run(id, cot, _, interrupted, failure):
            RunRow(cot: cot, subagentSummaries: subagentSummaries,
                   openSubagent: { openSubagent($0, from: id) },
                   openTrace: { tracedRun = TracedRun(id: id) },
                   todo: todo,
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

/// Content shown in a sheet whose images open full screen from the sheet
/// itself: a presentation over the sheet must come from inside it.
private struct ImageViewerHost<Content: View>: View {
    @ViewBuilder var content: Content
    @State private var viewing: ViewedImage?

    var body: some View {
        content
            .environment(\.inlineImageAction, InlineImageAction { image in
                viewing = ViewedImage(image: MessageImage(data: image.data, mimeType: image.mimeType))
            })
            .fullScreenCover(item: $viewing) { viewed in
                ImageViewer(image: viewed.image) { viewing = nil }
                    .presentationBackground(.clear)
            }
    }
}

/// The run a trace sheet is open for, by entry id.
private struct TracedRun: Identifiable {
    let id: String
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

/// What the user sent: the bubble, then any attached images. The bubble
/// mirrors AgentChatKit's UserMessageView, which takes plain text; the app
/// needs an attributed copy to paint the conversation's known skill names
/// blue (issue #143), and the plain-text bubble is unchanged when nothing
/// matches.
private struct UserRow: View, Equatable {
    let text: String
    let images: [MessageImage]
    let skillNames: [String]?

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !text.isEmpty {
                Text(attributedText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 18))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.leading, 48)
                    .textSelection(.enabled)
            }
            ForEach(images, id: \.data) { image in
                InlineImage(ToolImage(data: image.data, mimeType: image.mimeType), maxWidth: 240, maxHeight: 200)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    /// The core decides what counts as a mention; the app only converts its
    /// UTF-16 ranges to attributed ranges and colors them system blue.
    private var attributedText: AttributedString {
        var value = AttributedString(text)
        guard let skillNames, !skillNames.isEmpty else { return value }
        for range in SkillMentionHighlight.ranges(in: text, names: skillNames) {
            guard let stringRange = Range(range, in: text),
                  let lower = AttributedString.Index(stringRange.lowerBound, within: value),
                  let upper = AttributedString.Index(stringRange.upperBound, within: value)
            else { continue }
            value[lower..<upper].foregroundColor = Color(uiColor: .systemBlue)
        }
        return value
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.images == rhs.images && lhs.skillNames == rhs.skillNames
    }
}

/// One run: its trace capsule, the subagent cards, the answer as it
/// streams or settled, the failure line a dead run leaves behind, and on
/// the newest run the todo line last of all.
private struct RunRow: View, Equatable {
    let cot: CotView
    /// Supplies the subagent cards' call-given labels and roles; only the
    /// fields the cards show, so summary churn doesn't invalidate the row.
    let subagentSummaries: [UInt64: SubagentCardSummary]
    /// Pushes a card's child conversation; not part of equality, it only
    /// captures the model.
    let openSubagent: (UInt64) -> Void
    /// Opens the trace sheet; like `openSubagent`, not part of equality.
    let openTrace: () -> Void
    /// The conversation's todo line, handed to the newest run only — no
    /// other run shows it, and leaving it off them keeps a todo change from
    /// re-rendering every row.
    let todo: TodoLine?
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
        let trace = ChatAdapter.trace(cot: split.trace, interrupted: interrupted)
        VStack(alignment: .leading, spacing: 8) {
            AgentTraceView(trace, onOpen: openTrace)
            ForEach(split.cards) { card in
                SubagentCardView(card: card, onOpen: openSubagent)
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
            // The run's last element (ADR-0026 §4), under the answer.
            if let todo {
                TodoLineView(todo, onOpen: openTrace)
            }
        }
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.cot == rhs.cot && lhs.subagentSummaries == rhs.subagentSummaries
            && lhs.todo == rhs.todo
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
