import Foundation

/// What an agent did on the way to an answer: its thinking, the tools it
/// called and what it said in between. The answer itself is not part of it.
public struct AgentTrace: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        case thinking
        /// A tool call is streaming in or running.
        case acting
        /// The answer is streaming; the trace is done growing.
        case answering
        case settled
    }

    public enum Outcome: Sendable, Equatable {
        case completed
        case failed
        case interrupted
    }

    public var phase: Phase
    public var outcome: Outcome
    public var steps: [TraceStep]
    /// When the run's first model call started; live durations count from here.
    public var startedAt: Date?
    /// When the run stopped working (the answer's first token, or its end).
    public var endedAt: Date?

    public init(
        phase: Phase,
        outcome: Outcome = .completed,
        steps: [TraceStep],
        startedAt: Date? = nil,
        endedAt: Date? = nil
    ) {
        self.phase = phase
        self.outcome = outcome
        self.steps = steps
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}

public enum TraceStep: Sendable, Equatable, Identifiable {
    case thinking(id: String, text: String, isLive: Bool)
    /// Text the model addressed to the user mid-run, before calling a tool.
    case interim(id: String, text: String)
    /// Consecutive tool calls of one model message.
    case tools(id: String, calls: [ToolCall])

    public var id: String {
        switch self {
        case let .thinking(id, _, _), let .interim(id, _), let .tools(id, _): id
        }
    }
}

public struct ToolCall: Sendable, Equatable, Identifiable {
    public enum State: Sendable, Equatable {
        case streamingInput
        case running
        case succeeded
        case failed
    }

    public var id: String
    public var name: String
    public var state: State
    public var input: String?
    public var output: String?
    public var duration: Duration?
    /// Calls made from inside this one, as a script calling other tools.
    public var children: [ToolCall]

    public init(
        id: String,
        name: String,
        state: State,
        input: String? = nil,
        output: String? = nil,
        duration: Duration? = nil,
        children: [ToolCall] = []
    ) {
        self.id = id
        self.name = name
        self.state = state
        self.input = input
        self.output = output
        self.duration = duration
        self.children = children
    }
}
