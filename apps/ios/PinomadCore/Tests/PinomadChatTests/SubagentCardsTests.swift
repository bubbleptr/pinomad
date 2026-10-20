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
    status: ConversationStatus? = nil,
    updatedAt: Double? = nil,
    label: String? = nil,
    role: String? = nil,
    activity: SummaryActivity? = nil
) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: kind, parent: parent, forkedAt: nil,
        title: title, status: status, updatedAt: updatedAt,
        label: label, role: role, activity: activity
    )
}

/// The parent node a subagent is delegated from, with the child nested
/// exactly as the organized tree nests it.
private func parent(of child: ConversationSummary, sibling: ConversationSummary? = nil) -> ConversationNode {
    var children = [ConversationNode(summary: child, children: [])]
    if let sibling { children.append(ConversationNode(summary: sibling, children: [])) }
    return ConversationNode(
        summary: summary(id: 1, kind: .conversation, title: "Parent"),
        children: children
    )
}

private func summaries(of child: ConversationSummary) -> [UInt64: SubagentCardSummary] {
    ChatAdapter.subagentSummaries(in: parent(of: child))
}

@Suite("Subagent cards")
struct SubagentCardsTests {
    @Test func namedAgentAddsTheRoleToTheMetaLine() {
        let child = summary(id: 42, kind: .subagent, title: "Review the auth middleware", label: "Audit auth", role: "reviewer")
        let card = ChatAdapter.card(tool: subagentTool(), summary: summaries(of: child)[42], key: "s1/call-1")
        #expect(card.title == "Audit auth")
        #expect(card.role == "@reviewer")
        #expect(card.meta == ["@reviewer", "openai/gpt-5", "1m 5s"])
        #expect(card.status == .done)
    }

    @Test func ordinarySubagentHasNoRole() {
        let child = summary(id: 7, kind: .subagent, title: "Write the docs", label: "Write the docs")
        let card = ChatAdapter.card(
            tool: subagentTool(conversationId: 7, args: nil, model: nil, startedAt: nil, endedAt: nil),
            summary: summaries(of: child)[7],
            key: "s1/call-1"
        )
        #expect(card.role == nil)
        #expect(card.meta.isEmpty)
        #expect(card.title == "Write the docs")
    }

    /// The map a row compares must ignore summary fields that churn every
    /// snapshot, while still moving when the card's own fields move.
    @Test func summaryMapIgnoresUnrelatedChurn() {
        let child = summary(
            id: 42, kind: .subagent, parent: 1, title: "Review", status: .running, updatedAt: 10,
            label: "Audit auth", role: "reviewer", activity: SummaryActivity(tool: "read", target: "a")
        )
        let fork = summary(id: 2, kind: .fork, parent: 1, title: "Fork", updatedAt: 10)
        let before = ChatAdapter.subagentSummaries(in: parent(of: child, sibling: fork))

        let churnedChild = summary(
            id: 42, kind: .subagent, parent: 1, title: "Review", status: .failed, updatedAt: 99,
            label: "Audit auth", role: "reviewer", activity: SummaryActivity(tool: "bash", target: "b")
        )
        let churnedFork = summary(id: 2, kind: .fork, parent: 1, title: "Fork", updatedAt: 99)
        let after = ChatAdapter.subagentSummaries(in: parent(of: churnedChild, sibling: churnedFork))
        #expect(before == after)

        let renamed = summary(id: 42, kind: .subagent, parent: 1, title: "Review", label: "Audit auth", role: "planner")
        #expect(before != summaries(of: renamed))
    }

    /// The card's target is the child conversation the call recorded —
    /// what a tap pushes.
    @Test func cardCarriesTheChildConversationId() {
        let card = ChatAdapter.card(tool: subagentTool(conversationId: 42), summary: nil, key: "s1/call-1")
        #expect(card.conversationId == 42)
    }

    /// Before the call has recorded a child there is nowhere to go; the
    /// view uses this to drop the chevron and the tap target.
    @Test func cardWithoutAChildConversationHasNoTarget() {
        let tool = ToolItem(
            state: .inputAvailable, argsText: #"{"task":"review"}"#, children: [],
            diffStat: nil, durationMs: nil, images: [], output: nil,
            toolCallId: "call-1", toolName: "subagent", pinomad: nil
        )
        let card = ChatAdapter.card(tool: tool, summary: nil, key: "s1/call-1")
        #expect(card.conversationId == nil)
    }

    @Test func runWithoutSubagentsIsLeftAlone() {
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil, todoWrittenAtMs: nil,
            steps: [.tools(id: "s1", tools: [ToolItem(
                state: .outputAvailable, argsText: "README.md", children: [],
                diffStat: nil, durationMs: nil, images: [], output: "read",
                toolCallId: "call-1", toolName: "read", pinomad: nil
            )], live: false, activeToolCallId: nil)],
            answer: nil
        )
        let split = ChatAdapter.splitRun(cot, summaries: [:])
        #expect(split.cards.isEmpty)
        #expect(split.trace == cot)
    }

    @Test func splitRunLiftsTheCallAndReadsTheChildRole() {
        let child = summary(id: 42, kind: .subagent, parent: 1, label: "Audit auth", role: "reviewer")
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil, todoWrittenAtMs: nil,
            steps: [.tools(id: "s1", tools: [subagentTool()], live: false, activeToolCallId: nil)],
            answer: nil
        )
        let split = ChatAdapter.splitRun(cot, summaries: summaries(of: child))
        #expect(split.cards.map(\.role) == ["@reviewer"])
        #expect(split.trace.steps.isEmpty)
    }
}
