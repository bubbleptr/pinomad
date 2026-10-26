import AgentChatCore
import SwiftUI

/// A run's work as one line in the conversation, whatever its length.
/// While the agent works it names what the agent last said, or what it is
/// doing, and how long it has been at it; done, it says how the run went.
/// The steps never unfold in place — `onOpen` is for presenting them in an
/// `AgentTraceSheet`. It has no background, so its leading mark lines up
/// with the text around it.
public struct AgentTraceView: View {
    let trace: AgentTrace
    let mark: Image?
    let onOpen: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var markSize: CGFloat = 16

    /// `mark` leads a settled run in place of its outcome icon — the
    /// model's logo, say. A template image takes the label's color.
    public init(_ trace: AgentTrace, mark: Image? = nil, onOpen: @escaping () -> Void) {
        self.trace = trace
        self.mark = mark
        self.onOpen = onOpen
    }

    public var body: some View {
        let isWorking = trace.isWorking
        Button(action: onOpen) {
            // Ticks once a second only while the agent works.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let capsule = trace.capsule(at: isWorking ? context.date : .now)
                HStack(spacing: 6) {
                    InlinePager(page: capsule.label) { label in
                        // The mark pages with the label, so a finished
                        // run's mark arrives with its headline.
                        HStack(spacing: 5) {
                            if case .finished(let headline) = label {
                                if let mark {
                                    mark
                                        .resizable()
                                        .scaledToFit()
                                        .frame(width: markSize, height: markSize)
                                        .accessibilityHidden(true)
                                } else if let icon = TraceText.icon(headline) {
                                    Image(icon)
                                        .font(.subheadline.weight(.medium))
                                }
                            }
                            Text(text(for: label))
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .shimmering(label.isLive)
                        }
                    }
                    // The clock and counts stay outside the pager: they
                    // change every second, the label only with the work.
                    if let detail = TraceText.detail(capsule.summary, isWorking: isWorking) {
                        Text(detail)
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                    Image(Icon.chevronRight)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .foregroundStyle(capsule.label == .finished(.failed) ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                .padding(.vertical, 7)
                .contentShape(.rect)
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint(String(localized: "Shows the steps", bundle: .module))
    }

    private func text(for label: TraceCapsule.Label) -> String {
        switch label {
        case .interim(let line): line
        case .running(let running): TraceText.running(running)
        case .thinking: String(localized: "Thinking", bundle: .module)
        case .finished(let headline): TraceText.headline(headline)
        }
    }
}

extension AgentTrace {
    /// Still growing: the clocks tick and the labels name live work.
    var isWorking: Bool {
        outcome == .completed && (phase == .thinking || phase == .acting)
    }
}

private extension TraceCapsule.Label {
    var isLive: Bool {
        if case .finished = self { false } else { true }
    }
}

/// A run's steps in the order they happened — what the agent said between
/// them included — under the todo list when the run carries one. Meant as
/// sheet content: it brings its own detents. While the run is live it
/// follows the newest step, until the reader scrolls up; scrolling back to
/// the end follows again.
public struct AgentTraceSheet: View {
    let trace: AgentTrace
    let todo: TodoLine?

    @State private var position: ScrollPosition
    /// Whether new steps scroll into view: the reader is at the end.
    @State private var following: Bool

    public init(_ trace: AgentTrace, todo: TodoLine? = nil) {
        self.trace = trace
        self.todo = todo
        // A live run opens on its newest step; a finished one from the
        // start, where the todo list and the first step are.
        _position = State(initialValue: ScrollPosition(edge: trace.isWorking ? .bottom : .top))
        _following = State(initialValue: trace.isWorking)
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                TraceSheetHeader(trace: trace)
                if let todo {
                    TodoListView(line: todo)
                }
                TraceSteps(steps: trace.steps)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($position)
        // Growth keeps the end in view while the reader is there; a reader
        // who scrolled up owns the position until they come back. Only the
        // reader's scrolling decides which — content growing away from the
        // viewport is not the reader leaving the end — and a drag always
        // wins over growth, which would otherwise yank it back down.
        .onScrollPhaseChange { _, phase, context in
            if phase == .interacting {
                following = false
            } else if phase == .idle {
                let geometry = context.geometry
                following = geometry.visibleRect.maxY >= geometry.contentSize.height - 4
            }
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
            if following { position.scrollTo(edge: .bottom) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        // At the medium detent a drag scrolls the steps rather than growing
        // the sheet, so scrolling up is how the reader stops following.
        .presentationContentInteraction(.scrolls)
    }
}

private struct TraceSheetHeader: View {
    let trace: AgentTrace

    var body: some View {
        let isWorking = trace.isWorking
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let summary = trace.summary(at: isWorking ? context.date : .now)
            HStack(spacing: 6) {
                Text(TraceText.headline(summary.headline))
                    .font(.headline)
                    .foregroundStyle(summary.headline == .failed ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                    .shimmering(isWorking)
                if let detail = TraceText.detail(summary, isWorking: isWorking) {
                    Text(detail)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// The words a trace's summary and running call read as, shared by the
/// capsule and the sheet.
enum TraceText {
    static func headline(_ headline: TraceSummary.Headline) -> String {
        switch headline {
        case .thinking: String(localized: "Thinking", bundle: .module)
        case .working: String(localized: "Working", bundle: .module)
        case .thought: String(localized: "Thought", bundle: .module)
        case .worked: String(localized: "Worked", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .interrupted: String(localized: "Stopped", bundle: .module)
        }
    }

    /// A settled run's outcome mark. Live headlines have none: their label
    /// shimmers instead.
    static func icon(_ headline: TraceSummary.Headline) -> Icon? {
        switch headline {
        case .thinking, .working: nil
        case .thought: .brain
        case .worked: .circleCheck
        case .failed: .circleX
        case .interrupted: .circleStop
        }
    }

    /// The clock, and once done the number of tools.
    static func detail(_ summary: TraceSummary, isWorking: Bool) -> String? {
        var parts: [String] = []
        if let elapsed = summary.elapsed {
            parts.append(elapsed.formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow)))
        }
        if !isWorking, summary.toolCount > 0 {
            parts.append(String(localized: "\(summary.toolCount) tools", bundle: .module))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func running(_ running: ToolSummary.Running) -> String {
        if let nested = running.nestedName {
            return String(localized: "Running \(running.name) › \(nested)", bundle: .module)
        }
        return String(localized: "Running \(running.name)", bundle: .module)
    }
}

private struct TraceSteps: View {
    let steps: [TraceStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(steps) { step in
                switch step {
                case let .thinking(_, text, isLive, duration):
                    ThinkingStep(text: text, isLive: isLive, duration: duration)
                case let .interim(_, text):
                    // Addressed to the user: it reads as the answer does.
                    MarkdownView(markdown: text)
                case let .tools(_, calls):
                    ToolBatchRow(calls: calls)
                }
            }
        }
    }
}

/// A thinking step: while live its text streams in like the answer does —
/// word by word, each word fading in — capped near four lines with the
/// overflow fading out at the top so the steps below are not pushed further
/// down as it grows. Settled, it folds to a one-line "Thought" row; the
/// full text stays behind a disclosure, and a step with no text does not
/// open at all.
private struct ThinkingStep: View {
    let text: String
    let isLive: Bool
    let duration: Duration?

    @State private var stream: StreamingMarkdown?
    @State private var isExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // A stack, not a Group: a Group with no child yet (live, before
        // the first sync) passes its modifiers to nothing, so `onAppear`
        // never fires and the stream is never made.
        VStack(alignment: .leading, spacing: 0) {
            if isLive {
                if let stream { LiveThinking(stream: stream) }
            } else {
                settled
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: isLive)
        .onAppear(perform: sync)
        .onChange(of: text) { _, _ in sync() }
        .onChange(of: isLive) { _, live in
            if !live { stream?.finish() }
        }
    }

    /// Snapshots arrive whole: append only what is new, and when the text
    /// was rewritten — the new snapshot is not prefixed by the old — restart
    /// and show what is there at once rather than replaying it.
    private func sync() {
        guard isLive else { return }
        guard let stream else {
            let next = StreamingMarkdown()
            if !text.isEmpty { next.append(text) }
            self.stream = next
            return
        }
        if text.hasPrefix(stream.markdown) {
            let delta = String(text.dropFirst(stream.markdown.count))
            if !delta.isEmpty { stream.append(delta) }
        } else {
            let next = StreamingMarkdown(pace: nil)
            if !text.isEmpty { next.append(text) }
            self.stream = next
        }
    }

    private var settled: some View {
        let hasBody = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 6) {
            if hasBody {
                Button {
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { isExpanded.toggle() }
                } label: {
                    label(showChevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityHint(isExpanded ? String(localized: "Hides the thinking", bundle: .module) : String(localized: "Shows the thinking", bundle: .module))
            } else {
                label(showChevron: false)
            }
            if isExpanded, hasBody {
                MarkdownView(markdown: text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 24)
                    .transition(.opacity)
            }
        }
    }

    private func label(showChevron: Bool) -> some View {
        HStack(spacing: 8) {
            // Same icon column as the tool rows, so every step's text starts
            // at the same x.
            Image(Icon.brain)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(title)
                .font(.callout)
                .foregroundStyle(.secondary)
            if showChevron {
                Image(Icon.chevronRight)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
        .contentShape(.rect)
    }

    private var title: String {
        switch duration.flatMap({ $0.thoughtLength }) {
        case .brief: String(localized: "Thought briefly", bundle: .module)
        case .seconds(let seconds): String(localized: "Thought \(seconds)s", bundle: .module)
        case nil: String(localized: "Thought", bundle: .module)
        }
    }
}

/// Live thinking text, capped near four lines: the tail stays visible and
/// what has scrolled past fades out at the top.
private struct LiveThinking: View {
    let stream: StreamingMarkdown
    @State private var lineHeight: CGFloat = 22
    @State private var contentHeight: CGFloat = 0

    private var cap: CGFloat { lineHeight * 4 }

    var body: some View {
        StreamingMarkdownView(stream)
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { contentHeight = $0 }
            .frame(maxWidth: .infinity, maxHeight: cap, alignment: .bottom)
            .clipped()
            .mask {
                if contentHeight > cap {
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black, location: 0.4),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                } else {
                    Color.black
                }
            }
            .background(alignment: .topLeading) {
                // A one-line probe; the cap is in lines, not points.
                Text("Ag")
                    .font(.callout)
                    .opacity(0)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { lineHeight = $0 }
            }
    }
}

/// Consecutive tool calls of one model message, folded to a single row.
/// While any call is in progress the row names the running one — the
/// deepest when calls nest — and the label page-flips as work moves on;
/// settled, it is one past-tense summary. A single call's disclosure goes
/// straight to its input and output rather than a duplicate header; a
/// batch's lists each call.
private struct ToolBatchRow: View {
    let calls: [ToolCall]

    @State private var isExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// What the row's label shows; a change turns the pager's page.
    private enum Page: Hashable {
        case running(ToolSummary.Running)
        case settled
    }

    private var summary: ToolSummary { ToolSummary(calls: calls) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(symbol)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                    InlinePager(page: page) { page in
                        label(for: page)
                    }
                    Image(Icon.chevronRight)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(isExpanded ? String(localized: "Hides the calls", bundle: .module) : String(localized: "Shows the calls", bundle: .module))

            if isExpanded {
                detail
                    .padding(.leading, 24)
                    .transition(.opacity)
            }
        }
    }

    private var page: Page {
        summary.running.map(Page.running) ?? .settled
    }

    /// The running call's symbol while live; settled, the calls' shared
    /// symbol or a generic one when the batch mixes kinds.
    private var symbol: Icon {
        if let running = summary.running { return ToolSymbol.icon(for: running.name) }
        let symbols = Set(calls.map { ToolSymbol.icon(for: $0.name) })
        return symbols.count == 1 ? symbols.first! : .wrench
    }

    @ViewBuilder
    private var detail: some View {
        if calls.count == 1, let call = calls.first {
            ToolCallDetail(call: call)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(calls) { ToolCallRow(call: $0) }
            }
        }
    }

    @ViewBuilder
    private func label(for page: Page) -> some View {
        switch page {
        case .running(let running):
            Text(TraceText.running(running))
                .font(.callout)
                .foregroundStyle(.secondary)
                .shimmering(true)
                .lineLimit(1)
                .truncationMode(.tail)
        case .settled:
            HStack(spacing: 8) {
                Text(settledText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                // The summary truncates before the meta does.
                meta.fixedSize()
            }
        }
    }

    @ViewBuilder
    private var meta: some View {
        HStack(spacing: 8) {
            if let diff = summary.diffStat {
                HStack(spacing: 4) {
                    Text("+\(diff.additions)").foregroundStyle(.green)
                    Text("−\(diff.deletions)").foregroundStyle(.red)
                }
            }
            if summary.failedCount > 0 {
                Text("\(summary.failedCount) failed", bundle: .module)
                    .foregroundStyle(.red)
            }
        }
        .font(.caption)
        .monospacedDigit()
    }

    private var settledText: String {
        switch summary.label {
        case .single(let verb, let target, let name):
            if verb == .used { return String(localized: "Used \(name)", bundle: .module) }
            if let target { return verbText(verb, target: target) }
            return clause(verb, count: 1)
        case .buckets(let buckets):
            // Later clauses lose their capital: "Read 2 files, ran 1 command".
            return buckets.enumerated().reduce("") { text, pair in
                var clause = clause(pair.element.verb, count: pair.element.count)
                if !text.isEmpty {
                    clause = clause.prefix(1).lowercased() + clause.dropFirst()
                    return String(localized: "\(text), \(clause)", bundle: .module)
                }
                return clause
            }
        }
    }

    private func clause(_ verb: ToolSummary.Verb, count: Int) -> String {
        switch verb {
        case .ran: String(localized: "Ran \(count) commands", bundle: .module)
        case .read: String(localized: "Read \(count) files", bundle: .module)
        case .edited: String(localized: "Edited \(count) files", bundle: .module)
        case .wrote: String(localized: "Wrote \(count) files", bundle: .module)
        case .searchedPattern: String(localized: "Searched \(count) patterns", bundle: .module)
        case .searchedPath: String(localized: "Searched \(count) paths", bundle: .module)
        case .listed: String(localized: "Listed \(count) directories", bundle: .module)
        case .searchedWeb: String(localized: "Searched \(count) web pages", bundle: .module)
        case .fetched: String(localized: "Fetched \(count) pages", bundle: .module)
        case .used: String(localized: "Used \(count) tools", bundle: .module)
        }
    }

    private func verbText(_ verb: ToolSummary.Verb, target: String) -> String {
        switch verb {
        case .ran: String(localized: "Ran \(target)", bundle: .module)
        case .read: String(localized: "Read \(target)", bundle: .module)
        case .edited: String(localized: "Edited \(target)", bundle: .module)
        case .wrote: String(localized: "Wrote \(target)", bundle: .module)
        case .searchedPattern, .searchedPath, .searchedWeb: String(localized: "Searched \(target)", bundle: .module)
        case .listed: String(localized: "Listed \(target)", bundle: .module)
        case .fetched: String(localized: "Fetched \(target)", bundle: .module)
        case .used: String(localized: "Used \(target)", bundle: .module)
        }
    }
}
