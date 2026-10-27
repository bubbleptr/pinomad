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

    /// The shared calendar day for every message time. A local midnight timer
    /// and returning to the foreground both re-read it (the Web's useToday).
    @State private var clock = MessageClock(calendar: .autoupdatingCurrent)
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingOverview = false
    /// A subagent picked in the overview, pushed once the sheet is gone —
    /// pushing under a presented sheet glitches the transition.
    @State private var overviewSubagent: UInt64?
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
    /// The page's height inside the bars; caps how tall a question card's
    /// page grows. Measured outside the bottom bar, whose height depends on it.
    @State private var pageHeight: CGFloat?

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
        // Read the node once per version: the title, agent, retry rule and
        // card facts all derive from it.
        let node = self.node
        let title = node.map { displayName(summary: $0.summary) } ?? "Conversation"
        let isSubagent = node?.summary.kind == .subagent
        let agentPick = node.map {
            ConversationAgent(summary: $0.summary, isSubagent: isSubagent,
                              hostMinor: model.hostMinor,
                              roles: model.snapshot?.agents?.roles ?? [])
        }
        let subtitle = self.subtitle(agent: agentPick?.current)
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
                                Color.clear.frame(height: 1).id("top")
                                entries(conversation, subagentSummaries: subagentSummaries,
                                        isSubagent: isSubagent)
                                Color.clear.frame(height: 1).id("bottom")
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                        }
                        .defaultScrollAnchor(.bottom)
                        .task {
                            // `bounce` sweeps end to end so a settled
                            // conversation scrolls too; otherwise follow
                            // the end as a stream grows.
                            var up = false
                            while !Task.isCancelled {
                                if autoScrollBounce {
                                    up.toggle()
                                    withAnimation(.linear(duration: 1)) {
                                        proxy.scrollTo(up ? "top" : "bottom", anchor: up ? .top : .bottom)
                                    }
                                    try? await Task.sleep(for: .milliseconds(1400))
                                } else {
                                    proxy.scrollTo("bottom", anchor: .bottom)
                                    try? await Task.sleep(for: .milliseconds(120))
                                }
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
                                isSubagent: isSubagent)
                    }
                }
            } else {
                ConversationSkeleton()
            }
        }
        .environment(\.inlineImageAction, InlineImageAction { image in
            model.viewing = MessageImage(data: image.data, mimeType: image.mimeType, ref: image.ref)
        })
        // A run ending while the reader watches: done or failed. A stop is
        // the reader's own doing and stays quiet.
        .sensoryFeedback(trigger: conversation?.busy) { old, new in
            guard old == true, new == false,
                  case .run(_, _, _, let interrupted, let failure, _)? = conversation?.chat.last
            else { return nil }
            if failure != nil { return .error }
            return interrupted ? nil : .success
        }
        // A question arriving; opening a conversation that already has one doesn't count.
        .sensoryFeedback(.impact(weight: .medium), trigger: conversation?.questions.count) { old, new in
            guard let old, let new else { return false }
            return new > old
        }
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model) }
        // A bar, not a plain inset: the transcript scrolling under it gets
        // the system's soft edge instead of a hard cut at the card.
        .safeAreaBar(edge: .bottom) {
            if isSubagent {
                // A subagent belongs to its delegating task; the reader only
                // observes it. No composer, so nothing here can submit,
                // stop, compact, or change its model.
                Text("Subagent conversations are read-only")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            } else if let conversation {
                ConversationComposer(model: model, conversation: conversation, agentPick: agentPick)
                    // The agent at work, in the empty strip under the card:
                    // hung from the bar's bottom edge down past the home
                    // indicator; with the keyboard up, the keyboard covers it.
                    .overlay(alignment: .bottom) {
                        WorkingDots(active: conversation.busy)
                            .frame(height: 44)
                            .alignmentGuide(.bottom) { $0[.top] }
                    }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { pageHeight = $0 }
        .environment(\.questionPageMaxHeight, max((pageHeight ?? 800) * 0.4, 160))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .conversationSubtitle(subtitle)
        .toolbar {
            // Not disabled offline: the folder, branch and subagents come
            // from the snapshot; only the change stat needs the host.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingOverview = true
                } label: {
                    Image(.layoutGridCircles)
                }
                .accessibilityLabel("Overview")
            }
        }
        .sheet(isPresented: $showingOverview, onDismiss: {
            guard let child = overviewSubagent else { return }
            overviewSubagent = nil
            openSubagent(child, from: conversation.flatMap { ChatAdapter.runSpawning(child, in: $0.chat) })
        }) {
            OverviewSheet(model: model, conversationId: conversationId) { child in
                overviewSubagent = child
            }
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
        }
        .task(id: scenePhase) {
            // A suspended app's timer does not run; the active pass is what
            // catches a day change that happened in the background.
            guard scenePhase == .active else { return }
            clock.refresh()
            while !Task.isCancelled {
                let next = Calendar.autoupdatingCurrent.nextDate(
                    after: .now,
                    matching: DateComponents(hour: 0, minute: 0, second: 0),
                    matchingPolicy: .nextTime
                ) ?? .now.addingTimeInterval(3600)
                try? await Task.sleep(for: .seconds(max(1, next.timeIntervalSinceNow + 0.5)))
                clock.refresh()
            }
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

    private var autoScrollBounce: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["PINOMAD_AUTOSCROLL"] == "bounce"
        #else
        return false
        #endif
    }

    private var connected: Bool {
        guard let snapshot = model.snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }


    /// 「@角色 · 项目 · 分支」, each part when known. The branch is the
    /// worktree record's: the live one needs a `changes()` call, which only
    /// the overview makes.
    private func subtitle(agent: String?) -> String? {
        var parts: [String] = []
        if let agent { parts.append("@\(agent)") }
        if case .project(let path)? = conversation?.home {
            let project = model.snapshot?.organized.projects.first { $0.project.path == path }?.project
            parts.append(project?.name ?? (path as NSString).lastPathComponent)
        }
        if let branch = conversation?.checkout?.branch { parts.append(branch) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Record where to return before the session switches to the child. The
    /// run that delegated it is a stable anchor; a reader at the end keeps
    /// following the parent's stream instead.
    private func openSubagent(_ child: UInt64, from run: String?) {
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
           case let .run(_, cot, _, interrupted, _, _) = entry {
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
        if case .run(_, _, _, _, let failure, _)? = chat.last { return failure != nil }
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
        let latestRun = Self.latestRunId(conversation.chat)
        let todo = Self.todoLine(conversation)
        let rows = Transcript.rows(
            chat: conversation.chat,
            local: conversation.localSubmissions,
            attachmentDetails: model.sentFileDetails
        )
        ForEach(rows) { row in
            transcriptRow(row, conversation: conversation, retry: retry, latestRun: latestRun,
                          subagentSummaries: subagentSummaries, todo: todo)
        }
    }

    @ViewBuilder
    private func transcriptRow(
        _ row: TranscriptRow,
        conversation: ConversationSnapshot,
        retry: RetryRequest?,
        latestRun: String?,
        subagentSummaries: [UInt64: SubagentCardSummary],
        todo: TodoLine?
    ) -> some View {
        switch row {
        case let .entry(entry, status):
            switch entry {
            case let .user(_, text, images, skills, attachments, timestamp):
                // Only the skills the host expanded light up (ADR-0028).
                UserRow(
                    text: text, images: images, skills: skills, attachments: attachments,
                    timestamp: timestamp, status: status, error: nil,
                    today: clock.today, requestKey: nil,
                    retry: nil, edit: nil, editDisabled: false, editTooltip: nil,
                    pending: false
                ).equatable()
            case let .run(id, cot, _, interrupted, failure, endedAt):
                // Only the newest run may carry the failed run's retry and
                // the current todo: an older row with either would resend
                // the wrong prompt or show progress it never wrote.
                let retryRequest = id == conversation.chat.last?.entryId ? retry : nil
                RunRow(cot: cot, subagentSummaries: subagentSummaries,
                       openSubagent: { openSubagent($0, from: id) },
                       openTrace: { tracedRun = TracedRun(id: id) },
                       todo: id == latestRun ? todo : nil,
                       interrupted: interrupted, failure: failure, stream: model.streamFor(id),
                       endedAt: endedAt, today: clock.today,
                       retry: retryRequest.map { request in
                           { model.retry(request, conversation: conversationId) }
                       },
                       retryKey: retryRequest?.requestId).equatable()
            case .compaction:
                MarkerRow("Context compacted")
            case .reset:
                MarkerRow("Conversation reset")
            }
        case let .local(message):
            let availability = model.editAvailability(conversation: conversationId)
            UserRow(
                text: message.text, images: message.images, skills: message.skills,
                attachments: message.attachments, timestamp: nil, status: message.status,
                error: message.error, today: clock.today, requestKey: message.requestId,
                retry: { model.retrySubmission(conversation: conversationId, requestId: message.requestId) },
                edit: { model.editSubmission(conversation: conversationId, requestId: message.requestId) },
                editDisabled: availability.isDisabled, editTooltip: availability.tooltip,
                pending: !connected || model.submissionPending.contains(message.requestId)
            ).equatable()
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
                viewing = ViewedImage(image: MessageImage(
                    data: image.data, mimeType: image.mimeType, ref: image.ref))
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
    func conversationSubtitle(_ subtitle: String?) -> some View {
        if let subtitle {
            navigationSubtitle(subtitle)
        } else {
            self
        }
    }
}

/// What the user sent: the bubble, then any attached images, then the
/// delivery line — status and time beside a committed bubble, or the local
/// send's phase with Retry/Edit until the host replaces it (ADR-0034 §5).
/// The kit's UserMessageView carries the attributed text so the `$name`
/// mentions of the skills the host expanded paint blue (ADR-0028); the
/// bubble styling stays in one place.
private struct UserRow: View, Equatable {
    let text: String
    let images: [MessageImage]
    /// The skills the host expanded into this message.
    let skills: [String]
    /// Host-stored files the message referenced (issue #321); chips only.
    let attachments: [UserAttachment]
    /// When the host received a committed message; nil on a local send.
    let timestamp: Double?
    /// The delivery mark: delivered on the newest committed bubble, the
    /// phase on a local one.
    let status: MessageStatus?
    let error: String?
    let today: Date
    /// The local send's idempotency key; nil on a committed bubble. The
    /// retry/edit closures capture it, so equality uses this key instead.
    let requestKey: String?
    let retry: (() -> Void)?
    let edit: (() -> Void)?
    let editDisabled: Bool
    let editTooltip: String?
    let pending: Bool

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, file in
                SentFileChip(name: file.name, size: Int(clamping: file.size))
            }
            ForEach(Array(images.enumerated()), id: \.offset) { _, image in
                InlineImage(
                    ToolImage(data: image.data, mimeType: image.mimeType, ref: image.ref),
                    purpose: .userMessage,
                    maxWidth: 240,
                    maxHeight: 200
                )
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            if !text.isEmpty { UserMessageView(attributedText) }
            metadata
        }
    }

    /// The row under the bubble: icon, time, and local-only actions. It is
    /// always present and keeps one line, so a phase change never moves the
    /// bubble (the icon slot has a fixed width too).
    private var metadata: some View {
        HStack(spacing: 6) {
            if let status {
                Image(status.icon)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(status == .failed ? Color.red : Color.secondary)
                    .frame(width: 14, height: 14)
                    .accessibilityLabel(Text(status.label))
            }
            if let caption = status?.caption {
                Text(caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let time {
                Text(time.label)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityLabel(Text(time.full))
            }
            if let error, !error.isEmpty {
                Text(error)
                    .foregroundStyle(.red)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if let retry, status == .unknown || status == .failed {
                Button("Retry", action: retry)
                    .buttonStyle(.plain)
                    .fontWeight(.medium)
                    .foregroundStyle(pending ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.tint))
                    .disabled(pending)
            }
            // Only a refused send may be edited; an unconfirmed one must be
            // retried (which queries first) or left alone (ADR-0034 §7).
            if let edit, status == .failed {
                Button("Edit", action: edit)
                    .buttonStyle(.plain)
                    .fontWeight(.medium)
                    .foregroundStyle(editDisabled ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.tint))
                    .disabled(editDisabled || pending)
                    .accessibilityHint(Text(editDisabled ? editTooltip ?? "" : ""))
            }
        }
        .font(.caption)
        .frame(minHeight: 18)
    }

    private var time: MessageTime? {
        guard let timestamp else { return nil }
        return MessageTime(timestamp: timestamp, today: today)
    }

    /// The core decides what counts as a mention; the app only converts its
    /// UTF-16 ranges to attributed ranges and colors them system blue.
    private var attributedText: AttributedString {
        var value = AttributedString(text)
        for range in SkillMentionHighlight.ranges(in: text, names: skills) {
            guard let stringRange = Range(range, in: text),
                  let lower = AttributedString.Index(stringRange.lowerBound, within: value),
                  let upper = AttributedString.Index(stringRange.upperBound, within: value)
            else { continue }
            value[lower..<upper].foregroundColor = Color(uiColor: .systemBlue)
        }
        return value
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.images == rhs.images && lhs.skills == rhs.skills
            && lhs.attachments == rhs.attachments && lhs.timestamp == rhs.timestamp
            && lhs.status == rhs.status && lhs.error == rhs.error && lhs.today == rhs.today
            && lhs.requestKey == rhs.requestKey && lhs.pending == rhs.pending
            && lhs.editDisabled == rhs.editDisabled
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
    /// When the run's last answer finished, once settled; the answer's
    /// action row shows it (the Web's ChatMessageMetadata).
    let endedAt: Double?
    let today: Date
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
            AgentTraceView(trace, mark: cot.model.flatMap(modelLogoAsset).map { Image($0) }, onOpen: openTrace)
            ForEach(split.cards) { card in
                SubagentCardView(card: card, onOpen: openSubagent)
            }
            if cot.answer != nil {
                ReplyBody(answer: cot.answer!, stream: stream, endedAt: endedAt, today: today)
            } else if let endedAt, let time = MessageTime(timestamp: endedAt, today: today) {
                // A textless settled run still says when it stopped.
                Text(time.label)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(Text(time.full))
            }
            if let failure {
                RunFailureView(raw: failure)
            }
            if let retry, failure != nil {
                Button("Retry", image: .rotateCw, action: retry)
                    .buttonStyle(.tactile(.bordered))
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
            && lhs.endedAt == rhs.endedAt && lhs.today == rhs.today
    }
}

/// Why a run died: the provider's status and message, with the raw error
/// one tap away for a bug report or a closer look.
private struct RunFailureView: View {
    let raw: String
    @State private var showsDetails = false

    var body: some View {
        let text = RunFailureText(raw)
        VStack(alignment: .leading, spacing: 6) {
            Text(text.summary)
                .font(.callout)
                .foregroundStyle(.red)
            if text.hasDetails {
                HStack(spacing: 16) {
                    Button {
                        withAnimation(Motion.settle) { showsDetails.toggle() }
                    } label: {
                        HStack(spacing: 4) {
                            Text(showsDetails ? "Hide details" : "Details")
                            Image(.chevronDown)
                                .imageScale(.small)
                                .rotationEffect(.degrees(showsDetails ? 180 : 0))
                        }
                        .padding(.vertical, 6)
                        .contentShape(.rect)
                    }
                    Button("Copy error", image: .copy) {
                        UIPasteboard.general.string = raw
                    }
                    .labelStyle(.iconOnly)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                if showsDetails {
                    Text(raw)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
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
    let endedAt: Double?
    let today: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let stream {
                StreamingMarkdownView(stream)
                if stream.stream.isFinished {
                    HStack(spacing: 8) {
                        ReplyActions(markdown: stream.markdown)
                        if let time {
                            Text(time.label)
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .accessibilityLabel(Text(time.full))
                        }
                    }
                }
            }
        }
    }

    private var time: MessageTime? {
        guard let endedAt else { return nil }
        return MessageTime(timestamp: endedAt, today: today)
    }
}
