import Foundation
import PinomadCore
import Testing
@testable import PinomadChat

private func subagentTool(
    conversationId: UInt64 = 42,
    state: ToolPartState = .outputAvailable,
    args: String? = #"{"task":"review","description":"Audit auth"}"#,
    output: String? = nil,
    model: String? = "openai/gpt-5",
    startedAt: Double? = 1_000,
    endedAt: Double? = 66_000
) -> ToolItem {
    ToolItem(
        state: state,
        argsText: args,
        children: [],
        diffStat: nil,
        durationMs: nil,
        images: [],
        output: output,
        toolCallId: "call-1",
        toolName: "subagent",
        pinomad: .subagent(
            conversationId: conversationId, output: nil, model: model,
            startedAt: startedAt, endedAt: endedAt
        )
    )
}

private func summary(
    id: UInt64,
    kind: SummaryKind,
    parent: UInt64? = nil,
    title: String? = nil,
    label: String? = nil,
    role: String? = nil
) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: kind, parent: parent, forkedAt: nil,
        title: title, status: nil, updatedAt: nil,
        label: label, role: role, activity: nil
    )
}

@Suite("Subagent cards")
struct SubagentCardsTests {
    @Test func namedAgentAddsTheRoleToTheMetaLine() {
        let child = summary(id: 42, kind: .subagent, title: "Review the auth middleware", label: "Audit auth", role: "reviewer")
        let card = ChatAdapter.card(tool: subagentTool(), summary: child, key: "s1/call-1")
        #expect(card.title == "Audit auth")
        #expect(card.role == "@reviewer")
        #expect(card.meta == ["@reviewer", "openai/gpt-5", "1m 5s"])
        #expect(card.status == .done)
    }

    @Test func ordinarySubagentHasNoRole() {
        let child = summary(id: 7, kind: .subagent, title: "Write the docs", label: "Write the docs")
        let card = ChatAdapter.card(
            tool: subagentTool(conversationId: 7, args: nil, model: nil, startedAt: nil, endedAt: nil),
            summary: child,
            key: "s1/call-1"
        )
        #expect(card.role == nil)
        #expect(card.meta.isEmpty)
        #expect(card.title == "Write the docs")
    }

    @Test func runWithoutSubagentsIsLeftAlone() {
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil,
            steps: [.tools(id: "s1", tools: [ToolItem(
                state: .outputAvailable, argsText: "README.md", children: [],
                diffStat: nil, durationMs: nil, images: [], output: "read",
                toolCallId: "call-1", toolName: "read", pinomad: nil
            )], live: false, activeToolCallId: nil)],
            answer: nil
        )
        let split = ChatAdapter.splitRun(cot, organized: nil)
        #expect(split.cards.isEmpty)
        #expect(split.trace == cot)
    }

    @Test func splitRunLiftsTheCallAndReadsTheChildRole() {
        let child = summary(id: 42, kind: .subagent, parent: 1, label: "Audit auth", role: "reviewer")
        let organized = Organized(
            chats: [ConversationNode(
                summary: summary(id: 1, kind: .conversation, title: "Parent"),
                children: [ConversationNode(summary: child, children: [])]
            )],
            projects: [],
            archived: []
        )
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil,
            steps: [.tools(id: "s1", tools: [subagentTool()], live: false, activeToolCallId: nil)],
            answer: nil
        )
        let split = ChatAdapter.splitRun(cot, organized: organized)
        #expect(split.cards.map(\.role) == ["@reviewer"])
        #expect(split.trace.steps.isEmpty)
    }
}
