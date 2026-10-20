import Foundation

/// The one line a run takes in the conversation. Its steps never unfold in
/// place: the reader came for the answer, and the steps open in a sheet.
public struct TraceCapsule: Sendable, Equatable {
    public enum Label: Sendable, Hashable {
        /// The first line of what the model last said to the user mid-run.
        case interim(String)
        /// No interim yet: the tool running now.
        case running(ToolSummary.Running)
        /// No interim and no tool running: the model is working out its
        /// next move.
        case thinking
        /// The run stopped working; the headline says how.
        case finished(TraceSummary.Headline)
    }

    /// What the line names; a change turns the pager's page. Kept apart
    /// from the clock so the page does not turn every second.
    public var label: Label
    /// The elapsed time and tool counts shown after the label.
    public var summary: TraceSummary
}

extension AgentTrace {
    public func capsule(at now: Date) -> TraceCapsule {
        let summary = summary(at: now)
        let label: TraceCapsule.Label
        switch summary.headline {
        case .thinking, .working:
            label = latestInterimLine.map(TraceCapsule.Label.interim)
                ?? runningCall.map(TraceCapsule.Label.running)
                ?? .thinking
        default:
            label = .finished(summary.headline)
        }
        return TraceCapsule(label: label, summary: summary)
    }

    /// Interims are Markdown; the capsule is one plain line.
    private var latestInterimLine: String? {
        for step in steps.reversed() {
            guard case let .interim(_, text) = step else { continue }
            let line = PlainText.of(markdown: text)
                .split(whereSeparator: \.isNewline)
                .lazy
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .first { !$0.isEmpty }
            if let line { return line }
        }
        return nil
    }

    /// Only the newest step can be running; an older batch with a call in
    /// flight is stale data, not the current action.
    private var runningCall: ToolSummary.Running? {
        guard case let .tools(_, calls)? = steps.last else { return nil }
        return ToolSummary(calls: calls).running
    }
}
