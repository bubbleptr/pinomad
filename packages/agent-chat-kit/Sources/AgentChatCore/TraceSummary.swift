import Foundation

/// How a trace's work reads in one line: the capsule's settled label and
/// the clock and counts that follow any label.
public struct TraceSummary: Sendable, Equatable {
    public enum Headline: Sendable, Hashable {
        case thinking
        /// Making tool calls.
        case working
        /// Done, without calling a tool.
        case thought
        case worked
        case failed
        case interrupted
    }

    public var headline: Headline
    /// Whole seconds; ticks while the agent works, then stops.
    public var elapsed: Duration?
    /// Calls the model made itself; calls made from inside a tool are not counted.
    public var toolCount: Int
    public var failedToolCount: Int
}

extension AgentTrace {
    public func summary(at now: Date) -> TraceSummary {
        let calls = steps.flatMap { step -> [ToolCall] in
            if case let .tools(_, calls) = step { calls } else { [] }
        }
        let working = phase == .thinking || phase == .acting

        let headline: TraceSummary.Headline
        switch (outcome, phase) {
        case (.failed, _): headline = .failed
        case (.interrupted, _): headline = .interrupted
        case (_, .thinking): headline = .thinking
        case (_, .acting): headline = .working
        default: headline = calls.isEmpty ? .thought : .worked
        }

        let end = working ? now : endedAt
        let elapsed = startedAt.flatMap { start in
            end.map { Duration.seconds(Int(max($0.timeIntervalSince(start), 0))) }
        }
        return TraceSummary(
            headline: headline,
            elapsed: elapsed,
            toolCount: calls.count,
            failedToolCount: calls.count { $0.state == .failed }
        )
    }
}
