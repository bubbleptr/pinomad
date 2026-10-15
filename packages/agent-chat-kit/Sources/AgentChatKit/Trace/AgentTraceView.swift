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
                case let .thinking(_, text, isLive):
                    ThinkingStep(text: text, isLive: isLive)
                case let .interim(_, text):
                    MarkdownView(markdown: text)
                        .font(.callout)
                case let .tools(_, calls):
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(calls) { ToolCallRow(call: $0) }
                    }
                }
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Capsule().fill(.quaternary).frame(width: 2)
        }
    }
}

private struct ThinkingStep: View {
    let text: String
    let isLive: Bool

    var body: some View {
        if text.isEmpty {
            Text(isLive ? "Thinking…" : "Thought without a summary", bundle: .module)
                .font(.callout)
                .foregroundStyle(.tertiary)
        } else {
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
