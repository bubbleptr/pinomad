import PinomadCore
import Testing
@testable import PinomadChat

private func task(_ id: UInt64, _ status: ConversationStatus?) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: .subagent, parent: 1, forkedAt: nil,
        title: "task \(id)", status: status, updatedAt: nil,
        label: nil, role: nil, activity: nil
    )
}

private func run(_ id: String, spawning children: [UInt64]) -> ChatEntry {
    let tools = children.map { child in
        ToolItem(
            state: .outputAvailable, argsText: nil, children: [], diffStat: nil,
            durationMs: nil, images: [], output: nil, toolCallId: "call-\(child)",
            toolName: "subagent",
            pinomad: .subagent(conversationId: child, output: nil, model: nil, startedAt: nil, endedAt: nil)
        )
    }
    let cot = CotView(
        phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil, todoWrittenAtMs: nil,
        steps: [.tools(id: "\(id)-s", tools: tools, live: false, activeToolCallId: nil)],
        answer: nil
    )
    return .run(id: id, cot: cot, forkEntryId: nil, interrupted: false, failure: nil)
}

private func checkout(branch: String?) -> WorktreeCheckout {
    WorktreeCheckout(
        conversationId: 1, path: "/w", repo: "/r", subdir: "", branch: branch,
        base: "abc", snapshot: nil
    )
}

@Suite struct OverviewTests {
    /// Running and waiting tasks are listed up to the limit; the overflow,
    /// finished and failed ones fold into counts, in the family's order.
    @Test func runningTasksBeyondTheLimitFoldIntoCounts() {
        let tasks = [
            task(2, nil), task(3, .running), task(4, .needsAnswer), task(5, .failed),
            task(6, .running), task(7, .running), task(8, .other("paused")),
        ]
        let overview = SubagentOverview(tasks: tasks)
        #expect(overview.active.map(\.id) == [3, 4, 6])
        #expect(overview.moreRunning == 1)
        #expect(overview.finished == 2)
        #expect(overview.failed == 1)
    }

    /// The family's subagents, not only the shown conversation's own: a
    /// fork's tasks belong to the same overview.
    @Test func familyTasksComeFromTheRoot() throws {
        let fork = ConversationNode(
            summary: ConversationSummary(
                id: 9, kind: .fork, parent: 1, forkedAt: "e1", title: "fork", status: nil,
                updatedAt: nil, label: nil, role: nil, activity: nil
            ),
            children: [ConversationNode(summary: task(10, .running), children: [])]
        )
        let root = ConversationNode(
            summary: ConversationSummary(
                id: 1, kind: .conversation, parent: nil, forkedAt: nil, title: "root", status: nil,
                updatedAt: nil, label: nil, role: nil, activity: nil
            ),
            children: [ConversationNode(summary: task(2, nil), children: []), fork]
        )
        let organized = Organized(chats: [root], projects: [], archived: [])
        let overview = try #require(SubagentOverview.of(organized: organized, conversation: 9))
        #expect(overview.active.map(\.id) == [10])
        #expect(overview.finished == 1)
        let alone = Organized(chats: [ConversationNode(summary: root.summary, children: [])], projects: [], archived: [])
        #expect(SubagentOverview.of(organized: alone, conversation: 1) == nil)
    }

    /// Returning from a subagent opened in the overview reveals the run
    /// that delegated it, as returning from its card does.
    @Test func theSpawningRunIsTheOneCarryingTheCall() {
        let chat: [ChatEntry] = [
            run("r1", spawning: [2]),
            .user(id: "u2", text: "go on", images: []),
            run("r2", spawning: [3, 4]),
        ]
        #expect(ChatAdapter.runSpawning(4, in: chat) == "r2")
        #expect(ChatAdapter.runSpawning(2, in: chat) == "r1")
        #expect(ChatAdapter.runSpawning(9, in: chat) == nil)
    }

    /// On a host that reports the live branch, its answer wins — including
    /// a detached HEAD, which shows no branch even though the worktree
    /// record still names one. Before an answer, and on older hosts, the
    /// record stands in.
    @Test func theLiveBranchOverridesTheRecordOnlyWhereTheHostReportsIt() {
        let record = checkout(branch: "pinomad/fix-auth")
        let detached = ConversationChanges.available(base: "abc", files: [], truncated: false, branch: nil)
        let moved = ConversationChanges.unavailable(reason: "no repo", branch: "main")
        #expect(workspaceBranch(hostMinor: 11, changes: detached, checkout: record) == nil)
        #expect(workspaceBranch(hostMinor: 11, changes: moved, checkout: record) == "main")
        #expect(workspaceBranch(hostMinor: 11, changes: nil, checkout: record) == "pinomad/fix-auth")
        #expect(workspaceBranch(hostMinor: 10, changes: detached, checkout: record) == "pinomad/fix-auth")
        #expect(workspaceBranch(hostMinor: nil, changes: nil, checkout: nil) == nil)
    }
}
