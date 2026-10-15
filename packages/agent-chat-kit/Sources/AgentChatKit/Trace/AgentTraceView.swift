import AgentChatCore
import SwiftUI

/// What the agent did on the way to its answer: open while it works, folded
/// to one line once the answer starts.
public struct AgentTraceView: View {
    let trace: AgentTrace
    @State private var disclosure: TraceDisclosure
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ trace: AgentTrace) {
        self.trace = trace
        _disclosure = State(initialValue: TraceDisclosure(phase: trace.phase))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(motion) { disclosure.toggle() }
            } label: {
                TraceHeader(trace: trace, isExpanded: disclosure.isExpanded)
            }
            .buttonStyle(.plain)
            .accessibilityHint(disclosure.isExpanded ? String(localized: "Hides the steps", bundle: .module) : String(localized: "Shows the steps", bundle: .module))

            if disclosure.isExpanded, !trace.steps.isEmpty {
                TraceSteps(steps: trace.steps)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .onChange(of: trace.phase) { _, phase in
            withAnimation(motion) { disclosure.update(phase: phase) }
        }
    }

    private var motion: Animation? {
        reduceMotion ? nil : .snappy(duration: 0.25)
    }
}

private struct TraceHeader: View {
    let trace: AgentTrace
    let isExpanded: Bool

    private var isWorking: Bool { trace.phase == .thinking || trace.phase == .acting }

    var body: some View {
        // Ticks once a second only while the agent works.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let summary = trace.summary(at: isWorking ? context.date : .now)
            HStack(spacing: 6) {
                Text(headline(summary))
                    .font(.subheadline.weight(.medium))
                    .shimmering(isWorking)
                if let detail = detail(summary) {
                    Text(detail)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .foregroundStyle(summary.headline == .failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .contentShape(.rect)
        }
    }

    private func headline(_ summary: TraceSummary) -> String {
        switch summary.headline {
        case .thinking: String(localized: "Thinking", bundle: .module)
        case let .running(tool): String(localized: "Running \(tool)", bundle: .module)
        case .thought: String(localized: "Thought", bundle: .module)
        case .worked: String(localized: "Worked", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .interrupted: String(localized: "Stopped", bundle: .module)
        }
    }

    private func detail(_ summary: TraceSummary) -> String? {
        var parts: [String] = []
        if let elapsed = summary.elapsed {
            parts.append(elapsed.formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow)))
        }
        if !isWorking, summary.toolCount > 0 {
            parts.append(String(localized: "\(summary.toolCount) tools", bundle: .module))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
                    MarkdownView(markdown: text)
                        .font(.callout)
                case let .tools(_, calls):
                    ToolBatchRow(calls: calls)
                }
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Capsule().fill(.quaternary).frame(width: 2)
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
        Group {
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
        HStack(spacing: 6) {
            Text(title)
                .font(.callout)
                .foregroundStyle(.secondary)
            if showChevron {
                Image(systemName: "chevron.right")
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
                    Image(systemName: symbol)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                    InlinePager(page: page) { page in
                        label(for: page)
                    }
                    Image(systemName: "chevron.right")
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
    private var symbol: String {
        if let running = summary.running { return ToolSymbol.name(for: running.name) }
        let symbols = Set(calls.map { ToolSymbol.name(for: $0.name) })
        return symbols.count == 1 ? symbols.first! : "wrench.and.screwdriver"
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
            HStack(spacing: 8) {
                Text(runningText(running))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .shimmering(true)
                Spacer(minLength: 0)
            }
        case .settled:
            HStack(spacing: 8) {
                Text(settledText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                meta
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

    private func runningText(_ running: ToolSummary.Running) -> String {
        if let nested = running.nestedName {
            return String(localized: "Running \(running.name) › \(nested)", bundle: .module)
        }
        return String(localized: "Running \(running.name)", bundle: .module)
    }

    private var settledText: String {
        switch summary.label {
        case .single(let verb, let target, let name):
            if let target { return verbText(verb, target: target) }
            if verb == .used { return String(localized: "Used \(name)", bundle: .module) }
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
