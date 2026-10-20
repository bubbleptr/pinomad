import AgentChatCore
import Foundation
import PinomadCore

/// `ChatEntry`/`CotView`/`ToolItem` → AgentChatKit's trace model, in one
/// direction with no state of its own: each published snapshot maps to a
/// fresh model, and the views diff on it.
///
/// Mapping notes (kept next to the code so review can check them against
/// `packages/client/src/cot-view.ts`):
/// - Identity: the core's entry ids (`run-*`, `open-*`) and step ids pass
///   through untouched; `ToolItem.toolCallId` is the call's identity and a
///   call without one (codemode's stored children) gets a positional id
///   under its step.
/// - Streaming tail: the answer and live thinking arrive as whole strings
///   per snapshot; the views append only the new suffix (the kit's
///   `ThinkingStep`/`StreamingMarkdown` contract), so this layer just
///   hands text through.
/// - Failure/interruption: `ChatEntry.run.interrupted` and
///   `CotView.failed` both feed `AgentTrace.outcome`; the run's failure
///   message stays on the entry for the view to show under the trace.
/// - Unknown presentations (ADR-0005): a `pinomad` detail the card cannot
///   render as a widget is folded into the output text — the diff patch
///   joins the output, a subagent keeps a labeled line — so nothing the
///   host sent silently disappears.
public enum ChatAdapter {
    /// A run's chain-of-thought as the kit renders it.
    public static func trace(cot: CotView, interrupted: Bool) -> AgentTrace {
        AgentTrace(
            phase: phase(of: cot.phase),
            outcome: outcome(failed: cot.failed, interrupted: interrupted),
            steps: cot.steps.map(step),
            startedAt: cot.anchorMs.map { Date(timeIntervalSince1970: $0 / 1000) },
            endedAt: end(of: cot),
            todoWrittenAt: cot.todoWrittenAtMs.map { Date(timeIntervalSince1970: $0 / 1000) }
        )
    }

    /// The conversation's todo document (`ConversationSnapshot.todo`); nil
    /// while it has none. Which run shows it is the view's call
    /// (`TodoLine`), from each run's `todoWrittenAt`.
    public static func todo(_ items: [TodoItem]?) -> TodoList? {
        items.map { items in
            TodoList(items: items.map { item in
                TodoList.Item(text: item.text, status: status(of: item.status))
            })
        }
    }

    /// One step's calls, in message order — the kit folds a batch itself.
    /// `activeToolCallId` names the call the core says is executing; calls
    /// whose input is complete but which have not started are demoted to
    /// `streamingInput` (waiting), so the folded row's "running" call is
    /// the real one rather than the last submitted.
    public static func calls(of stepId: String, tools: [ToolItem], activeToolCallId: String? = nil) -> [AgentChatCore.ToolCall] {
        tools.enumerated().map { index, tool in
            call(tool, fallbackId: "\(stepId).t\(index)", activeToolCallId: activeToolCallId)
        }
    }

    /// A single call. `input` prefers the target the core extracts from
    /// JSON args (a path tail or the command) over the raw payload — the
    /// folded row reads it, and the full args stay in the details pane of
    /// callers that set them (codemode's args are already the script).
    public static func call(_ tool: ToolItem, fallbackId: String, activeToolCallId: String? = nil) -> AgentChatCore.ToolCall {
        let id = tool.toolCallId ?? fallbackId
        return AgentChatCore.ToolCall(
            id: id,
            name: toolDisplayName(name: tool.toolName) ?? tool.toolName ?? "tool",
            state: state(of: tool.state, waiting: activeToolCallId != nil && id != activeToolCallId),
            input: toolTargetFromArgs(argsText: tool.argsText) ?? tool.argsText,
            output: output(of: tool),
            duration: tool.durationMs.map { .milliseconds(Int($0.rounded())) },
            diffStat: tool.diffStat.map {
                AgentChatCore.DiffStat(additions: Int($0.additions), deletions: Int($0.deletions))
            },
            images: tool.images.map { ToolImage(data: $0.data, mimeType: $0.mimeType) },
            children: tool.children.enumerated().map { index, child in
                call(child, fallbackId: "\(id).c\(index)")
            },
            isActive: id == activeToolCallId
        )
    }

    private static func step(_ step: CotStep) -> TraceStep {
        switch step {
        case let .thinking(id, text, live):
            .thinking(id: id, text: text, isLive: live)
        case let .interim(id, text):
            .interim(id: id, text: text)
        case let .tools(id, tools, _, activeToolCallId):
            .tools(id: id, calls: calls(of: id, tools: tools, activeToolCallId: activeToolCallId))
        }
    }

    private static func phase(of phase: CotPhase) -> AgentTrace.Phase {
        switch phase {
        // A run that has produced nothing yet is still presented as
        // "thinking" — the run exists, the model has not answered.
        case .hidden, .thinking: .thinking
        case .acting: .acting
        case .answering: .answering
        case .settled: .settled
        }
    }

    private static func status(of status: TodoStatus) -> TodoList.Status {
        switch status {
        case .pending: .pending
        case .inProgress: .inProgress
        case .completed: .completed
        }
    }

    private static func outcome(failed: Bool, interrupted: Bool) -> AgentTrace.Outcome {
        if failed { .failed } else if interrupted { .interrupted } else { .completed }
    }

    private static func state(of state: ToolPartState, waiting: Bool) -> AgentChatCore.ToolCall.State {
        switch state {
        case .inputStreaming: .streamingInput
        // `inputAvailable` means submitted; the core executes in order, so
        // when the step names a different active call this one is queued —
        // "preparing" — rather than running.
        case .inputAvailable: waiting ? .streamingInput : .running
        case .outputAvailable: .succeeded
        case .outputError: .failed
        }
    }

    /// `endedAt` is when the run stopped working — the first answer token
    /// (`anchor + elapsed`) or nothing while still live.
    private static func end(of cot: CotView) -> Date? {
        guard let anchor = cot.anchorMs, let elapsed = cot.elapsedMs else { return nil }
        return Date(timeIntervalSince1970: (anchor + elapsed) / 1000)
    }

    private static func output(of tool: ToolItem) -> String? {
        var output = tool.output
        switch tool.pinomad {
        case .diff(let patch):
            output = output.map { $0 + "\n\n" + patch } ?? patch
        case let .subagent(conversationId, recorded, model, _, _):
            // The detail carries the child's recorded result; it stands in
            // when the call's own output is absent.
            output = output ?? recorded
            var line = "Subagent — conversation #\(conversationId)"
            if let model { line += " · \(model)" }
            output = output.map { $0 + "\n\n" + line } ?? line
        case nil:
            break
        }
        return output
    }
}

extension ChatEntry {
    /// Every case carries its id as the first payload — one place to key
    /// the transcript's `ForEach`.
    public var entryId: String {
        switch self {
        case let .user(id, _, _), let .run(id, _, _, _, _), let .compaction(id), let .reset(id):
            id
        }
    }
}
