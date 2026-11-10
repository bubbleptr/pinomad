import Foundation
import PinomadCore
import Testing
@testable import PinomadChat

private func subagent(
    _ id: UInt64,
    parent: UInt64 = 1,
    lifecycle: SubagentLifecycle? = .background,
    name: String? = nil,
    model: ModelRef? = nil,
    status: ConversationStatus? = nil,
    updatedAt: Double? = nil,
    label: String? = nil
) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: .subagent, lifecycle: lifecycle, name: name, model: model,
        parent: parent, forkedAt: nil, title: nil, status: status, updatedAt: updatedAt,
        label: label, role: nil, activity: nil
    )
}

private func organized(root children: [ConversationNode]) -> Organized {
    let root = ConversationSummary(
        id: 1, kind: .conversation, parent: nil, forkedAt: nil, title: "Root",
        status: nil, updatedAt: nil, label: nil, role: nil, activity: nil
    )
    return Organized(chats: [ConversationNode(summary: root, children: children)], projects: [], archived: [])
}

private func leaf(_ summary: ConversationSummary) -> ConversationNode {
    ConversationNode(summary: summary, children: [])
}

/// The shown conversation's node, as the page reads it.
private func node(_ tree: Organized, _ id: UInt64) -> ConversationNode {
    findConversation(organized: tree, id: id)!
}

private func items(_ ids: [UInt64]) -> [BackgroundSubagent] {
    ids.map { BackgroundSubagent(id: $0, name: "s\($0)", label: nil, model: nil, branch: nil,
                                 working: false, failed: false) }
}

@Suite("Background subagents")
struct BackgroundSubagentsTests {
    // MARK: Messaging gate

    @Test func oldHostIsReadOnlyEvenWithAName() {
        let summary = subagent(2, name: "reviewer")
        #expect(SubagentMessaging(summary: summary, hostMinor: 32) == .readOnly)
    }

    /// A subagent from before ADR-0046 has no name; the host refuses its
    /// messages, so the composer must not appear.
    @Test func unnamedSubagentIsReadOnlyOnANewHost() {
        #expect(SubagentMessaging(summary: subagent(2, name: nil), hostMinor: 33) == .readOnly)
    }

    @Test func runningForegroundSubagentIsInItsCall() {
        let summary = subagent(2, lifecycle: .foreground, name: "reviewer", status: .running)
        #expect(SubagentMessaging(summary: summary, hostMinor: 33) == .inCall)
        let legacy = subagent(2, lifecycle: nil, name: "reviewer", status: .running)
        #expect(SubagentMessaging(summary: legacy, hostMinor: 33) == .inCall)
    }

    /// An idle foreground subagent — its card's call has returned — takes
    /// messages: that is how the user reaches it.
    @Test func idleForegroundSubagentIsOpen() {
        let summary = subagent(2, lifecycle: .foreground, name: "reviewer", status: nil)
        #expect(SubagentMessaging(summary: summary, hostMinor: 33) == .open)
    }

    @Test func runningBackgroundSubagentIsOpen() {
        let summary = subagent(2, lifecycle: .background, name: "reviewer", status: .running)
        #expect(SubagentMessaging(summary: summary, hostMinor: 33) == .open)
    }

    // MARK: Names

    @Test func subagentGoesByItsName() {
        #expect(conversationName(summary: subagent(2, name: "reviewer", label: "Audit auth")) == "reviewer")
        #expect(conversationName(summary: subagent(2, name: nil, label: "Audit auth")) == "Audit auth")
    }

    // MARK: The strip's list

    /// Working ones lead in dispatch order (cycling must not jump as they
    /// churn); the rest follow, most recent first.
    @Test func workingFirstThenMostRecent() {
        let tree = organized(root: [
            leaf(subagent(2, name: "a", updatedAt: 10)),
            leaf(subagent(3, name: "b", status: .running, updatedAt: 5)),
            leaf(subagent(4, name: "c", updatedAt: 30)),
            leaf(subagent(5, name: "d", status: .running, updatedAt: 99)),
            leaf(subagent(6, name: "e", status: .failed, updatedAt: 20)),
        ])
        let list = BackgroundSubagents.of(shown: node(tree, 1), organized: tree, calls: [:], models: [])
        #expect(list.map(\.id) == [3, 5, 4, 6, 2])
        #expect(list.map(\.working) == [true, true, false, false, false])
    }

    /// Foreground subagents live on their cards and in the overview, not here.
    @Test func foregroundSubagentsAreLeftOut() {
        let tree = organized(root: [
            leaf(subagent(2, lifecycle: .foreground, name: "a")),
            leaf(subagent(3, name: "b")),
        ])
        #expect(BackgroundSubagents.of(shown: node(tree, 1), organized: tree, calls: [:], models: []).map(\.id) == [3])
    }

    /// A fork's background subagents belong to the whole family; a shown
    /// subagent gets no strip of its own.
    @Test func wholeFamilyFromAForkButNoneInsideASubagent() {
        let fork = ConversationSummary(
            id: 7, kind: .fork, parent: 1, forkedAt: "e1", title: "Fork",
            status: nil, updatedAt: nil, label: nil, role: nil, activity: nil
        )
        let tree = organized(root: [
            leaf(subagent(2, name: "a")),
            ConversationNode(summary: fork, children: [leaf(subagent(8, parent: 7, name: "b"))]),
        ])
        #expect(Set(BackgroundSubagents.of(shown: node(tree, 7), organized: tree, calls: [:], models: []).map(\.id)) == [2, 8])
        #expect(BackgroundSubagents.of(shown: node(tree, 2), organized: tree, calls: [:], models: []).isEmpty)
    }

    /// The second line's facts: the summary's model by its listed name, the
    /// branch from the call; the label only when it adds to the name.
    @Test func itemCarriesModelBranchAndLabel() {
        let ref = ModelRef(provider: "openai", modelId: "gpt-6.1-sol")
        let tree = organized(root: [
            leaf(subagent(2, name: "reviewer", model: ref, label: "Audit auth middleware")),
            leaf(subagent(3, name: "notes", label: "notes")),
        ])
        let models = [ModelSummary(
            provider: "openai", modelId: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: nil,
            thinkingLevels: [], images: false
        )]
        let calls = [
            UInt64(2): SubagentCallFacts(model: "openai/gpt-6.1-sol", branch: "pinomad/41-ab12"),
            UInt64(3): SubagentCallFacts(model: "anthropic/claude-x", branch: nil),
        ]
        let list = BackgroundSubagents.of(shown: node(tree, 1), organized: tree, calls: calls, models: models)
        let reviewer = list.first { $0.id == 2 }
        #expect(reviewer?.label == "Audit auth middleware")
        #expect(reviewer?.model == "GPT-6.1-Sol")
        #expect(reviewer?.branch == "pinomad/41-ab12")
        let notes = list.first { $0.id == 3 }
        #expect(notes?.label == nil)
        #expect(notes?.model == "anthropic/claude-x")
    }

    // MARK: Selection

    @Test func selectionFollowsItsSubagentAcrossAReorder() {
        var selection = BackgroundSelection()
        selection.sync(items([2, 3, 4]))
        selection.next(items([2, 3, 4]))
        #expect(selection.id == 3)
        // 4 starts working and moves to the front: the strip still shows 3.
        let reordered = items([4, 2, 3])
        #expect(selection.index(in: reordered) == 2)
        selection.sync(reordered)
        #expect(selection.id == 3)
    }

    @Test func selectionClampsWhenItsSubagentLeaves() {
        var selection = BackgroundSelection()
        selection.sync(items([2, 3, 4]))
        selection.next(items([2, 3, 4]))
        selection.next(items([2, 3, 4]))
        #expect(selection.id == 4)
        // The last one leaves: stay at the end rather than jump to the first.
        let shorter = items([2, 3])
        #expect(selection.index(in: shorter) == 1)
        selection.sync(shorter)
        #expect(selection.id == 3)
        // The middle one leaves: the same position shows its successor.
        var middle = BackgroundSelection()
        middle.sync(items([2, 3, 4]))
        middle.next(items([2, 3, 4]))
        #expect(middle.index(in: items([2, 4])) == 1)
    }

    @Test func nextWrapsAndEmptyHasNoSelection() {
        var selection = BackgroundSelection()
        selection.sync(items([2, 3]))
        selection.next(items([2, 3]))
        selection.next(items([2, 3]))
        #expect(selection.id == 2)
        #expect(selection.index(in: []) == nil)
        selection.sync([])
        #expect(selection.id == nil)
    }

    // MARK: Call facts

    @Test func callFactsComeFromTheTranscriptsSubagentCalls() {
        let tool = ToolItem(
            state: .outputAvailable, argsText: #"{"task":"t","background":true}"#, children: [],
            diffStat: nil, durationMs: nil, images: [], output: nil, toolCallId: "c1", toolName: "subagent",
            pinomad: .subagent(conversationId: 9, output: nil, model: "openai/gpt-5",
                               startedAt: nil, endedAt: nil, branch: "pinomad/9-x")
        )
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil, todoWrittenAtMs: nil,
            steps: [.tools(id: "s1", tools: [tool], live: false, activeToolCallId: nil)], answer: nil
        )
        let chat: [ChatEntry] = [.run(id: "r1", cot: cot, forkEntryId: nil, interrupted: false, failure: nil)]
        #expect(ChatAdapter.subagentCalls(in: chat) == [9: SubagentCallFacts(model: "openai/gpt-5", branch: "pinomad/9-x")])
    }
}
