import AgentChatCore
import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func tool(
    state: ToolPartState = .outputAvailable,
    args: String? = nil,
    output: String? = nil,
    callId: String? = "call-1",
    name: String? = "read",
    pinomad: PinomadToolDetail? = nil,
    children: [ToolItem] = []
) -> ToolItem {
    ToolItem(
        state: state,
        argsText: args,
        children: children,
        diffStat: nil,
        durationMs: nil,
        images: [],
        output: output,
        toolCallId: callId,
        toolName: name,
        pinomad: pinomad
    )
}

private func cot(
    phase: CotPhase = .settled,
    failed: Bool = false,
    todoWrittenAtMs: Double? = nil,
    steps: [CotStep] = [],
    answer: CotAnswer? = nil
) -> CotView {
    CotView(
        phase: phase,
        failed: failed,
        anchorMs: nil,
        elapsedMs: nil,
        todoWrittenAtMs: todoWrittenAtMs,
        steps: steps,
        answer: answer
    )
}

@Suite("ChatAdapter identity")
struct IdentityTests {
    @Test func stepAndCallIdsPassThrough() {
        let step = CotStep.tools(
            id: "s1/2",
            tools: [tool(callId: "call-abc"), tool(callId: "call-def")],
            live: false,
            activeToolCallId: nil
        )
        let trace = ChatAdapter.trace(cot: cot(steps: [step]), interrupted: false)
        guard case let .tools(id, calls) = trace.steps[0] else {
            Issue.record("expected a tools step")
            return
        }
        #expect(id == "s1/2")
        #expect(calls.map(\.id) == ["call-abc", "call-def"])
    }

    @Test func callsWithoutIdsGetStablePositionalFallbacks() {
        let nested = tool(callId: nil, name: "bash")
        let step = CotStep.tools(
            id: "s9",
            tools: [tool(callId: nil, name: "codemode", children: [nested])],
            live: false,
            activeToolCallId: nil
        )
        let trace = ChatAdapter.trace(cot: cot(steps: [step]), interrupted: false)
        guard case let .tools(_, calls) = trace.steps[0] else {
            Issue.record("expected a tools step")
            return
        }
        #expect(calls[0].id == "s9.t0")
        #expect(calls[0].children[0].id == "s9.t0.c0")
    }

    @Test func entryIdsComeFromTheCore() {
        let entries: [ChatEntry] = [
            .user(id: "u1", text: "hi", images: []),
            .run(id: "run-7", cot: cot(), forkEntryId: nil, interrupted: false, failure: nil),
            .compaction(id: "c1"),
            .reset(id: "r1"),
        ]
        #expect(entries.map(\.entryId) == ["u1", "run-7", "c1", "r1"])
    }
}

@Suite("ChatAdapter live state")
struct LiveStateTests {
    @Test func liveThinkingMapsIsLiveAndText() {
        let step = CotStep.thinking(id: "th", text: "reasoning…", live: true)
        let trace = ChatAdapter.trace(cot: cot(phase: .thinking, steps: [step]), interrupted: false)
        guard case let .thinking(_, text, isLive, _) = trace.steps[0] else {
            Issue.record("expected a thinking step")
            return
        }
        #expect(text == "reasoning…")
        #expect(isLive)
        #expect(trace.phase == .thinking)
    }

    @Test func toolStatesMapOntoCallStates() {
        let states: [(ToolPartState, AgentChatCore.ToolCall.State)] = [
            (.inputStreaming, .streamingInput),
            (.inputAvailable, .running),
            (.outputAvailable, .succeeded),
            (.outputError, .failed),
        ]
        for (toolState, expected) in states {
            #expect(ChatAdapter.call(tool(state: toolState), fallbackId: "x").state == expected)
        }
    }

    /// The batch's folded row must name the call the core says is
    /// executing — submitted-but-queued calls are waiting, not running.
    @Test func activeToolCallIdPicksTheRunningCall() {
        let step = CotStep.tools(
            id: "s1",
            tools: [
                tool(state: .inputAvailable, callId: "call-read", name: "read"),
                tool(state: .inputAvailable, callId: "call-bash", name: "bash"),
            ],
            live: true,
            activeToolCallId: "call-read"
        )
        let trace = ChatAdapter.trace(cot: cot(phase: .acting, steps: [step]), interrupted: false)
        guard case let .tools(_, calls) = trace.steps[0] else {
            Issue.record("expected a tools step")
            return
        }
        #expect(calls[0].state == .running && calls[0].isActive)
        #expect(calls[1].state == .streamingInput && !calls[1].isActive)
        #expect(ToolSummary(calls: calls).running?.name == "read")
    }

    /// Without an active id the old position rule stands.
    @Test func noActiveIdKeepsPositionalRunning() {
        let calls = ChatAdapter.calls(of: "s", tools: [
            tool(state: .inputAvailable, callId: "a", name: "read"),
            tool(state: .inputAvailable, callId: "b", name: "bash"),
        ])
        #expect(calls.map(\.state) == [.running, .running])
        #expect(ToolSummary(calls: calls).running?.name == "bash")
    }
}

@Suite("ChatAdapter failure and interruption")
struct OutcomeTests {
    @Test func failedRunMapsToFailedOutcome() {
        let trace = ChatAdapter.trace(cot: cot(failed: true), interrupted: false)
        #expect(trace.outcome == .failed)
    }

    @Test func interruptedRunMapsToInterruptedOutcome() {
        let trace = ChatAdapter.trace(cot: cot(), interrupted: true)
        #expect(trace.outcome == .interrupted)
    }

    @Test func failedToolMapsToFailedCall() {
        let call = ChatAdapter.call(tool(state: .outputError, output: "Not run: the answer was interrupted."), fallbackId: "x")
        #expect(call.state == .failed)
        #expect(call.output == "Not run: the answer was interrupted.")
    }

    @Test func phasePrecedenceMatchesCotView() {
        #expect(ChatAdapter.trace(cot: cot(phase: .answering), interrupted: false).phase == .answering)
        #expect(ChatAdapter.trace(cot: cot(phase: .acting), interrupted: false).phase == .acting)
        #expect(ChatAdapter.trace(cot: cot(phase: .hidden), interrupted: false).phase == .thinking)
    }
}

@Suite("ChatAdapter fallbacks")
struct FallbackTests {
    @Test func diffPatchJoinsTheOutput() {
        let call = ChatAdapter.call(
            tool(output: "applied", pinomad: .diff(patch: "-a\n+b")),
            fallbackId: "x"
        )
        #expect(call.output == "applied\n\n-a\n+b")
    }

    @Test func subagentKeepsALabeledLine() {
        let call = ChatAdapter.call(
            tool(output: nil, pinomad: .subagent(
                conversationId: 42, output: "done", model: "openai/gpt-5",
                startedAt: nil, endedAt: nil
            )),
            fallbackId: "x"
        )
        #expect(call.output == "done\n\nSubagent — conversation #42 · openai/gpt-5")
    }

    @Test func unknownToolNameFallsBackToRawName() {
        #expect(ChatAdapter.call(tool(name: "mcp__exotic__thing"), fallbackId: "x").name == "exotic/thing")
        #expect(ChatAdapter.call(tool(name: nil), fallbackId: "x").name == "tool")
    }

    @Test func jsonArgsPreferTheExtractedTarget() {
        let call = ChatAdapter.call(
            tool(args: #"{"file_path":"/tmp/a/b.txt"}"#),
            fallbackId: "x"
        )
        #expect(call.input == "/tmp/a/b.txt")
    }

    @Test func nonJsonArgsPassThroughVerbatim() {
        let call = ChatAdapter.call(tool(args: "echo hello"), fallbackId: "x")
        #expect(call.input == "echo hello")
    }

    @Test func imagesBecomeToolImages() {
        var item = tool()
        item.images = [MessageImage(data: "aGk=", mimeType: "image/png")]
        let call = ChatAdapter.call(item, fallbackId: "x")
        #expect(call.images == [ToolImage(data: "aGk=", mimeType: "image/png")])
    }
}

@Suite("ChatAdapter todo")
struct TodoTests {
    @Test func theRunsLastTodoWriteBecomesItsDate() {
        let trace = ChatAdapter.trace(cot: cot(todoWrittenAtMs: 1_760_000_123_456), interrupted: false)
        #expect(trace.todoWrittenAt == Date(timeIntervalSince1970: 1_760_000_123.456))
        #expect(ChatAdapter.trace(cot: cot(), interrupted: false).todoWrittenAt == nil)
    }

    @Test func theConversationsTodoKeepsItsItemsInOrder() {
        let list = ChatAdapter.todo([
            TodoItem(text: "Reproduce", status: .completed),
            TodoItem(text: "Fix", status: .inProgress),
            TodoItem(text: "Ship", status: .pending),
        ])
        #expect(list == TodoList(items: [
            .init(text: "Reproduce", status: .completed),
            .init(text: "Fix", status: .inProgress),
            .init(text: "Ship", status: .pending),
        ]))
        #expect(ChatAdapter.todo(nil) == nil)
    }

    /// One entry per run, oldest first, skipping the entries that are not
    /// runs — `TodoLine` reads the last one as the newest run.
    @Test func todoWritesListEveryRunInOrder() {
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "plan it", images: []),
            .run(id: "run-1", cot: cot(todoWrittenAtMs: 2_000), forkEntryId: nil, interrupted: false, failure: nil),
            .compaction(id: "c1"),
            .user(id: "u2", text: "go on", images: []),
            .run(id: "run-2", cot: cot(), forkEntryId: nil, interrupted: false, failure: nil),
            .user(id: "u3", text: "queued", images: []),
        ]
        #expect(ChatAdapter.todoWrites(in: chat) == [Date(timeIntervalSince1970: 2), nil])
    }
}

private func answeredRun(_ id: String, text: String, streaming: Bool = false) -> ChatEntry {
    .run(
        id: id,
        cot: cot(answer: CotAnswer(text: text, streaming: streaming)),
        forkEntryId: nil,
        interrupted: false,
        failure: nil
    )
}

@Suite("ReplyStreams")
@MainActor
struct ReplyStreamsTests {
    @Test func switchingConversationsEvictsTheOldRunsStreams() {
        let streams = ReplyStreams()
        streams.sync(chat: [answeredRun("run-a", text: "answer A")])
        streams.sync(chat: [answeredRun("run-b", text: "answer B")])
        #expect(streams.stream(for: "run-a") == nil)
        #expect(streams.stream(for: "run-b")?.markdown == "answer B")
    }

    @Test func streamingTailOnlyAppendsTheNewSuffix() {
        let streams = ReplyStreams()
        streams.sync(chat: [answeredRun("run-1", text: "hello", streaming: true)])
        let first = streams.stream(for: "run-1")
        streams.sync(chat: [answeredRun("run-1", text: "hello world", streaming: true)])
        #expect(streams.stream(for: "run-1") === first)
        #expect(first?.markdown == "hello world")
    }

    @Test func rewrittenAnswerRestartsTheStream() {
        let streams = ReplyStreams()
        streams.sync(chat: [answeredRun("run-1", text: "first")])
        streams.sync(chat: [answeredRun("run-1", text: "different")])
        #expect(streams.stream(for: "run-1")?.markdown == "different")
    }
}
