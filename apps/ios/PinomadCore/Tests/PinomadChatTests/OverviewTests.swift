import PinomadCore
import Testing
@testable import PinomadChat

private func task(
    _ id: UInt64, _ status: ConversationStatus?, updatedAt: Double? = nil, activity: SummaryActivity? = nil
) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: .subagent, parent: 1, forkedAt: nil,
        title: "task \(id)", status: status, updatedAt: updatedAt,
        label: nil, role: nil, activity: activity
    )
}

private func run(_ id: String, spawning children: [UInt64]) -> ChatEntry {
    let tools = children.map { child in
        ToolItem(
            state: .outputAvailable, argsText: nil, children: [], diffStat: nil,
            durationMs: nil, images: [], output: nil, toolCallId: "call-\(child)",
            toolName: "subagent",
            pinomad: .subagent(conversationId: child, output: nil, model: nil, startedAt: nil, endedAt: nil, branch: nil)
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
    /// iOS has no Tasks panel, so every subagent is listed: the ones at work
    /// in the family's order, then failed, then finished, each newest first.
    /// Waiting for an answer is at work, not singled out.
    @Test func everySubagentIsListedAtWorkThenFailedThenDone() {
        let tasks = [
            task(2, nil, updatedAt: 10), task(3, .running), task(4, .needsAnswer), task(5, .failed, updatedAt: 5),
            task(6, .running), task(7, nil, updatedAt: 30), task(8, .failed, updatedAt: 40),
        ]
        let overview = SubagentOverview(tasks: tasks)
        #expect(overview.rows.map(\.id) == [3, 4, 6, 8, 5, 7, 2])
        #expect(overview.rows.map(\.tone) == [.running, .running, .running, .failed, .failed, .done, .done])
    }

    /// "Show all" folds only finished work: every subagent at work stays
    /// listed, however many there are, and a short list doesn't fold.
    @Test func theFoldNeverHidesASubagentAtWork() {
        let busy = SubagentOverview(tasks: (2...6).map { task($0, .running) } + [task(7, nil), task(8, .failed)])
        #expect(busy.listed == 5)
        #expect(busy.rows.prefix(busy.listed).allSatisfy { $0.tone == .running })
        let quiet = SubagentOverview(tasks: [task(2, .running), task(3, nil), task(4, nil), task(5, nil)])
        #expect(quiet.listed == SubagentOverview.minimumListed)
    }

    /// Each row says where it stands in words, so the icon's color is never
    /// the only signal.
    @Test func subagentRowsSayTheirStateInWords() {
        let overview = SubagentOverview(tasks: [
            task(3, .running, activity: SummaryActivity(tool: "bash", target: "bun test")),
            task(4, .needsAnswer), task(5, .running), task(6, .failed), task(7, nil),
        ])
        #expect(overview.rows.map(\.state) == [
            "Running · bash bun test", "Waiting for an answer", "Running", "Failed", "Done",
        ])
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
        #expect(overview.rows.map(\.id) == [10, 2])
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

    /// The folder's name is already on the row, so the path under it stops
    /// at the parent — a project's, even from its worktree. A chat's folder
    /// is named "Chat folder", so it keeps its full path.
    @Test func thePathUnderTheNameStopsAtTheParent() {
        let project = Home.project(path: "/Users/k/code/pinomad")
        #expect(workspaceFolderPath(cwd: "/Users/k/.pinomad/worktrees/1", home: project) == "/Users/k/code")
        #expect(workspaceFolderPath(cwd: "/Users/k/.pinomad/chats/4", home: .chat) == "/Users/k/.pinomad/chats/4")
        #expect(workspaceFolderPath(cwd: "/srv/app", home: nil) == "/srv")
        #expect(workspaceFolderPath(cwd: "/app", home: nil) == "/")
    }

    /// A clean checkout has nothing to open, so the Changes row waits for
    /// an answer with at least one file.
    @Test func onlyACheckoutWithFilesHasChanges() {
        let file = PatchFile(
            path: "a.txt", oldPath: nil, isNew: false, isDeleted: false, binary: true,
            additions: 0, deletions: 0, lines: []
        )
        #expect(workspaceHasChanges(.available(base: "abc", files: [file], truncated: false, branch: nil)))
        #expect(!workspaceHasChanges(.available(base: "abc", files: [], truncated: false, branch: "main")))
        #expect(!workspaceHasChanges(.unavailable(reason: "no repo", branch: nil)))
        #expect(!workspaceHasChanges(nil))
    }
}

private func process(
    _ id: String, _ state: ProcessState, active: Bool? = nil,
    pid: UInt64? = nil, startedAt: Double = 10_000, endedAt: Double? = nil,
    status: String? = nil, result: String? = nil
) -> BackgroundProcess {
    BackgroundProcess(
        id: id, owner: 1, name: id, command: "run \(id)", pid: pid,
        startedAt: startedAt, endedAt: endedAt, state: state,
        active: active ?? {
            if case .starting = state { return true }
            if case .running = state { return true }
            return false
        }(),
        status: status ?? "Running",
        result: result ?? ""
    )
}

private func processView(
    _ root: UInt64, _ processes: [BackgroundProcess], stopAvailable: Bool = true
) -> ProcessesView {
    ProcessesView(
        root: root, processes: processes, stopAvailable: stopAvailable,
        unavailable: stopAvailable ? nil : "The host couldn't load its process module; its log says which package is missing"
    )
}

private func family() -> (Organized, UInt64, UInt64) {
    let rootId: UInt64 = 1
    let forkId: UInt64 = 9
    let fork = ConversationNode(
        summary: ConversationSummary(
            id: forkId, kind: .fork, parent: rootId, forkedAt: "e1", title: "fork", status: nil,
            updatedAt: nil, label: nil, role: nil, activity: nil
        ),
        children: []
    )
    let root = ConversationNode(
        summary: ConversationSummary(
            id: rootId, kind: .conversation, parent: nil, forkedAt: nil, title: "root", status: nil,
            updatedAt: nil, label: nil, role: nil, activity: nil
        ),
        children: [fork]
    )
    return (Organized(chats: [root], projects: [], archived: []), rootId, forkId)
}

@Suite struct ProcessesOverviewTests {
    /// The list belongs to the family root: opening the overview on a fork
    /// still reads the root's watched list, never another family's.
    @Test func aForkReadsItsRootsProcesses() {
        let (organized, rootId, forkId) = family()
        let view = processView(rootId, [process("dev", .running)])
        let overview = ProcessesOverview.of(
            organized: organized, conversation: forkId, processes: view)
        #expect(overview?.rows.map(\.id) == ["dev"])

        let other = processView(rootId + 1, [process("dev", .running)])
        #expect(ProcessesOverview.of(organized: organized, conversation: forkId, processes: other) == nil)
        #expect(ProcessesOverview.of(organized: organized, conversation: forkId, processes: processView(rootId, [])) == nil)
    }

    /// A lost process keeps the host's long wording and pid, and neither it
    /// nor an ended process offers Stop.
    @Test func lostAndEndedProcessesHaveNoStop() {
        let (organized, rootId, forkId) = family()
        let lost = process(
            "old", .lost, pid: 777, startedAt: 1, endedAt: 2,
            status: "Lost track after a host restart; it may still be running (pid 777)", result: "Lost"
        )
        let exited = process(
            "build", .exited(exited: 1, signal: nil), startedAt: 3, endedAt: 4,
            status: "Exited with code 1", result: "exit 1"
        )
        let running = process("dev", .running, startedAt: 5)
        let overview = ProcessesOverview.of(
            organized: organized, conversation: forkId,
            processes: processView(rootId, [running, exited, lost])
        )!
        #expect(overview.rows.map(\.id) == ["dev", "build", "old"])
        #expect(overview.rows.filter(\.canStop).map(\.id) == ["dev"])
        let old = overview.rows.last!
        #expect(old.status.contains("may still be running"))
        #expect(old.status.contains("pid 777"))
        #expect(old.state == "Lost track")
        #expect(!old.canStop)
    }

    /// Without the host's process module the historical rows still show, but
    /// nothing offers Stop and the reason travels with the view.
    @Test func aHostWithoutTheModuleKeepsTheRowsButNotStop() {
        let (organized, rootId, forkId) = family()
        let view = processView(rootId, [process("dev", .running), process("old", .lost)], stopAvailable: false)
        let overview = ProcessesOverview.of(organized: organized, conversation: forkId, processes: view)!
        #expect(overview.rows.count == 2)
        #expect(overview.rows.allSatisfy { !$0.canStop })
        #expect(overview.unavailable?.contains("process module") == true)
    }

    /// The icon's color comes from the state: a clean exit or a stop is
    /// over, a non-zero exit, a failed start or a lost pty failed. The row
    /// says it in a few words.
    @Test func processRowsHaveAToneAndAShortState() {
        let (organized, rootId, forkId) = family()
        let processes = [
            process("dev", .running),
            process("test", .exited(exited: 1, signal: nil), endedAt: 4),
            process("build", .exited(exited: 0, signal: nil), endedAt: 3),
            process("old", .lost, endedAt: 2),
        ]
        let overview = ProcessesOverview.of(
            organized: organized, conversation: forkId, processes: processView(rootId, processes))!
        #expect(overview.rows.map(\.tone) == [.running, .failed, .done, .failed])
        #expect(overview.rows.map(\.state) == ["Running", "Exited 1", "Exited 0", "Lost track"])
        #expect(processShortText(.stopped(stopped: "user")) == "Stopped")
        #expect(processShortText(.failed(failed: "ENOENT")) == "Failed to start")
        #expect(processShortText(.exited(exited: nil, signal: "SIGKILL")) == "Exited (SIGKILL)")
    }

    @Test func elapsedTextUsesWholeSeconds() {
        #expect(processElapsedText(ms: 12_900) == "12s")
        #expect(processElapsedText(ms: 65_000) == "1m 5s")
        #expect(processElapsedText(ms: -1) == "0s")
        // dureview's trigger: a startedAt far outside Date/Int range must
        // hide the duration, not trap in the Int conversion.
        #expect(processElapsedText(ms: 1e25) == "")
        #expect(processElapsedText(ms: -1e25) == "")
        #expect(processElapsedText(ms: .infinity) == "")
        #expect(processElapsedText(ms: .nan) == "")
    }

    /// Many processes fold the same way Subagents does: three live and three
    /// ended rows, with the overflow counted.
    @Test func manyProcessesFoldIntoCounts() {
        let (organized, rootId, forkId) = family()
        let live = (0..<5).map { process("run\($0)", .running, startedAt: Double(100 + $0)) }
        let ended = (0..<4).map {
            process("old\($0)", .exited(exited: 0, signal: nil),
                    startedAt: Double($0), endedAt: Double(1000 + $0), result: "exit 0")
        }
        let overview = ProcessesOverview.of(
            organized: organized, conversation: forkId,
            processes: processView(rootId, live + ended)
        )!
        #expect(overview.rows.map(\.id) == ["run0", "run1", "run2", "old0", "old1", "old2"])
        #expect(overview.moreRunning == 2)
        #expect(overview.moreEnded == 1)
    }
}
