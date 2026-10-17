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
    /// `duration` is set once the step ends; the folded row reads it.
    case thinking(id: String, text: String, isLive: Bool, duration: Duration? = nil)
    /// Text the model addressed to the user mid-run, before calling a tool.
    case interim(id: String, text: String)
    /// Consecutive tool calls of one model message.
    case tools(id: String, calls: [ToolCall])

    public var id: String {
        switch self {
        case let .thinking(id, _, _, _), let .interim(id, _), let .tools(id, _): id
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
    /// Line counts of an edit, when the call reports them.
    public var diffStat: DiffStat?
    /// Images the result carried, rendered after the output pane.
    public var images: [ToolImage]
    /// Calls made from inside this one, as a script calling other tools.
    public var children: [ToolCall]
    /// The host marked this call as the one executing now — submitted
    /// but not yet running calls stay queued behind it, so a batch's
    /// summary should show this one rather than the last in-progress.
    public var isActive: Bool

    public init(
        id: String,
        name: String,
        state: State,
        input: String? = nil,
        output: String? = nil,
        duration: Duration? = nil,
        diffStat: DiffStat? = nil,
        images: [ToolImage] = [],
        children: [ToolCall] = [],
        isActive: Bool = false
    ) {
        self.id = id
        self.name = name
        self.state = state
        self.input = input
        self.output = output
        self.duration = duration
        self.diffStat = diffStat
        self.images = images
        self.children = children
        self.isActive = isActive
    }
}

/// An image attached to a tool result, as wire data — decoding is the
/// view's job so the model stays UI-free.
public struct ToolImage: Sendable, Equatable {
    /// Base64-encoded image bytes.
    public var data: String
    public var mimeType: String

    public init(data: String, mimeType: String) {
        self.data = data
        self.mimeType = mimeType
    }
}

/// Lines an edit added and removed.
public struct DiffStat: Sendable, Equatable {
    public var additions: Int
    public var deletions: Int

    public init(additions: Int, deletions: Int) {
        self.additions = additions
        self.deletions = deletions
    }
}

/// How long a settled thinking step took, as its folded row reports it.
public enum ThoughtLength: Sendable, Equatable {
    /// Under a second: not worth a number.
    case brief
    case seconds(Int)
}

extension Duration {
    /// Whole seconds, rounded; under one counts as brief rather than
    /// claiming a second that was never spent, and a negative length — a
    /// clock mistake, not a measurement — claims no number at all.
    public var thoughtLength: ThoughtLength? {
        let ms = Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
        if ms < 0 { return nil }
        return ms < 1000 ? .brief : .seconds(Int((ms / 1000).rounded()))
    }
}
