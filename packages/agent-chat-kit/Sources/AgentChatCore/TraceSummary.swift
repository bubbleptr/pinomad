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
    /// Whole seconds; ticks while the agent works, then stops. The live
    /// clock floors, while a settled duration rounds and reads at least 1s.
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
            end.map { stop in
                let measured = max(stop.timeIntervalSince(start), 0)
                // Floor the live clock so it never shows a second early or
                // claims 1s at the start. Once settled, match the web:
                // round and never read as 0s.
                let seconds = working ? Int(measured) : max(1, Int(measured.rounded()))
                return Duration.seconds(seconds)
            }
        }
        return TraceSummary(
            headline: headline,
            elapsed: elapsed,
            toolCount: calls.count,
            failedToolCount: calls.count { $0.state == .failed }
        )
    }
}
