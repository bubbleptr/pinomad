#if DEBUG
import Foundation
import PinomadChat
import PinomadCore
import UIKit

/// Dev-only launch channels for scripted simulator and device runs:
/// `-pairingLink` / `-autoPair` / `-openConversation` launch arguments and
/// their `PINOMAD_*` environment equivalents. The whole file is compiled out
/// of Release: a shipped app must not offer a way to inject a host, keep the
/// screen awake, or toggle the perf instrumentation. Debug behavior is the
/// scripted flow the device and perf runs rely on.
extension AppModel {
    /// Apply the launch-time dev channels. Returns true when one took over
    /// startup, so `start()` skips the stored-host path.
    func applyDevLaunch() -> Bool {
        // devicectl cannot pass single-dash args to a device app (it clusters
        // them as its own short options), so the same three values are also
        // read from PINOMAD_* environment variables.
        let args = UserDefaults.standard
        let env = ProcessInfo.processInfo.environment
        if env["PINOMAD_KEEPSCREEN"] != nil {
            // Perf runs: keep the phone awake so a scripted measurement
            // window isn't cut short by auto-lock.
            UIApplication.shared.isIdleTimerDisabled = true
        }
        if env["PINOMAD_PERFLOG"] != nil {
            PerfLog.shared.startFrameMonitor()
        }
        if let openId = args.string(forKey: "openConversation") ?? env["PINOMAD_OPEN"],
           let n = UInt64(openId) {
            pendingOpen = n
        }
        let injected = args.string(forKey: "pairingLink") ?? env["PINOMAD_PAIRING_LINK"] ?? ""
        if !injected.isEmpty, args.bool(forKey: "autoPair") || env["PINOMAD_AUTOPAIR"] != nil {
            reloadHosts()
            pair(link: injected)
            // Scripted runs race the network coming up (tailnet, VPN
            // toggles) — keep retrying the injected link rather than
            // dropping the operator to a failed screen.
            if env["PINOMAD_AUTOPAIR"] != nil { schedulePairRetries(injected) }
            return true
        }
        if env["PINOMAD_DEMO"] != nil {
            // No host needed: synthesize a streaming conversation so the
            // reply path (StreamingMarkdown + its fade) can be exercised
            // on a device that cannot reach one.
            phase = .connected
            startDemo()
            return true
        }
        if env["PINOMAD_DEMO_SUBAGENTS"] != nil {
            // The subagent cards' states: one named agent and one ordinary
            // call, so their layouts can be compared without a host.
            phase = .connected
            startSubagentDemo()
            return true
        }
        if let mode = env["PINOMAD_DEMO_OVERVIEW"] {
            // The overview sheet: a worktree conversation in a project, a
            // change stat (`truncated` marks it approximate), and running
            // plus settled subagents.
            phase = .connected
            startOverviewDemo(truncated: mode == "truncated")
            return true
        }
        if let mode = env["PINOMAD_DEMO_TRACE"] {
            // A run that keeps working: the capsule's live label, the todo
            // line and the trace sheet following new steps. `quiet` never
            // says anything mid-run, so the label is the current action.
            phase = .connected
            startTraceDemo(interims: mode != "quiet")
            return true
        }
        if let mode = env["PINOMAD_DEMO_QUESTIONS"] {
            // The agent's question card without a host: four questions, or
            // `single` for a one-question request; `offline` shows the four
            // with the connection down (Submit disabled).
            phase = .connected
            startQuestionDemo(mode)
            return true
        }
        if let mode = env["PINOMAD_DEMO_SETTINGS"] {
            // The settings pages over two demo machines; `failed` opens on
            // the failure page instead of the list.
            startSettingsDemo(mode)
            return true
        }
        if let mode = env["PINOMAD_DEMO_LAYOUT"] {
            // The conversation list grouped by machine: two paired hosts
            // (one connected), chats, two projects, a family with subagents;
            // `old` connects a host too old to add projects.
            phase = .connected
            startLayoutDemo(mode)
            return true
        }
        if let context = env["PINOMAD_DEMO_CONTEXT"] {
            // The composer's context meter at a scripted usage, for
            // screenshots on a simulator that cannot reach a host.
            phase = .connected
            startContextDemo(context)
            return true
        }
        if !injected.isEmpty {
            // No auto-pair: pre-fill the pairing field after the normal
            // launch, exactly as a pasted link would.
            loadAccount()
            connectActive()
            offerPairing(injected)
            return true
        }
        return false
    }

    /// Route `-openConversation` / `PINOMAD_OPEN` after the first ready.
    func consumeDevOpenRequest() {
        guard let id = pendingOpen else { return }
        pendingOpen = nil
        navPath = [.conversation(id)]
    }

    /// Retries the injected pairing link while the phase is a failure —
    /// only armed by PINOMAD_AUTOPAIR, so manual pairing stays manual.
    private func schedulePairRetries(_ link: String) {
        pairRetryTask?.cancel()
        pairRetryTask = Task { [weak self] in
            for _ in 0..<40 {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                if case .failed = self.phase {
                    self.pair(link: link)
                } else {
                    return
                }
            }
        }
    }

    /// Drives a synthetic streaming answer — the same snapshot/sync path
    /// the session uses, so a blank screen reproduces exactly what the
    /// host-driven view would show.
    private func startDemo() {
        navPath = [.conversation(1)]
        let body = """
        This is a streaming output demo. **Markdown** appears word by word, and you should see it fade in.

        ## Section heading

        - First item: the content keeps growing
        - Second item: shows up next
        - Third item: checks the pacing

        ```swift
        let stream = StreamingMarkdown()
        stream.append("hello")
        ```

        A closing paragraph of body text; by this point the answer is about done.
        """
        let words = (0..<3).map { _ in body }.joined()
        var text = ""
        var version: UInt64 = 0
        Task { [weak self] in
            for (i, ch) in words.enumerated() {
                guard let self, !Task.isCancelled else { return }
                text.append(ch)
                self.demoPublish(answer: text, streaming: i < words.count - 1, version: &version)
                try? await Task.sleep(for: .milliseconds(40))
            }
        }
    }

    /// A settled run with two delegated tasks — one named agent, one
    /// ordinary subagent — for the card layout (role line present/absent).
    private func startSubagentDemo() {
        navPath = [.conversation(1)]
        let now = Date.now.timeIntervalSince1970 * 1000
        let parent = ConversationSummary(
            id: 1, kind: .conversation, parent: nil, forkedAt: nil,
            title: "Pre-release checks", status: nil, updatedAt: now,
            label: nil, role: nil, activity: nil
        )
        let reviewed = ConversationSummary(
            id: 2, kind: .subagent, parent: 1, forkedAt: nil,
            title: "Review the auth middleware", status: nil, updatedAt: now,
            label: "Review login middleware", role: "reviewer", activity: nil
        )
        let plain = ConversationSummary(
            id: 3, kind: .subagent, parent: 1, forkedAt: nil,
            title: "Write the release notes", status: nil, updatedAt: now,
            label: "Compile release notes", role: nil, activity: nil
        )
        let organized = Organized(
            chats: [ConversationNode(summary: parent, children: [
                ConversationNode(summary: reviewed, children: []),
                ConversationNode(summary: plain, children: []),
            ])],
            projects: [], archived: []
        )
        let reviewOutput = "No auth bypass found in the login middleware; suggest moving the session expiry into config."
        let notesOutput = "Release notes are grouped under \"Added / Fixed / Upgrade notes\"."
        let tools = [
            ToolItem(
                state: .outputAvailable,
                argsText: #"{"task":"Review login middleware","description":"Review login middleware"}"#,
                children: [], diffStat: nil, durationMs: nil, images: [],
                output: reviewOutput, toolCallId: "call-review", toolName: "subagent",
                pinomad: .subagent(
                    conversationId: 2, output: reviewOutput, model: "anthropic/claude-x",
                    startedAt: now - 65_000, endedAt: now
                )
            ),
            ToolItem(
                state: .outputAvailable,
                argsText: #"{"task":"Compile release notes","description":"Compile release notes"}"#,
                children: [], diffStat: nil, durationMs: nil, images: [],
                output: notesOutput, toolCallId: "call-notes", toolName: "subagent",
                pinomad: .subagent(
                    conversationId: 3, output: notesOutput, model: "openai/gpt-5",
                    startedAt: now - 12_000, endedAt: now
                )
            ),
        ]
        let cot = CotView(
            phase: .settled, failed: false,
            anchorMs: now - 90_000, elapsedMs: 90_000, todoWrittenAtMs: nil,
            steps: [.tools(id: "s1", tools: tools, live: false, activeToolCallId: nil)],
            answer: CotAnswer(text: "Both subagents are done: the login middleware looks clean, and the release notes are grouped by category.", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "Before the release, check the login middleware and put together the release notes.", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: nil),
            questions: [], todo: nil, home: nil, checkout: nil, busy: false, contextUsage: nil
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, hostName: nil, settings: nil, devices: [], organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: conversation
        ))
        replyStreams.sync(chat: chat)
    }

    /// A project conversation in its own worktree that delegated seven
    /// subagents — four still running, one waiting for an answer — with a
    /// canned `changes()` answer behind the overview's stat and file list.
    private func startOverviewDemo(truncated: Bool) {
        navPath = [.conversation(1)]
        let now = Date.now.timeIntervalSince1970 * 1000
        let projectPath = "/Users/void/code/pinomad"
        let worktree = "/Users/void/.pinomad/worktrees/pinomad/overview-sheet"
        func summary(
            _ id: UInt64, _ kind: SummaryKind, _ title: String, label: String? = nil,
            status: ConversationStatus? = nil, role: String? = nil, activity: SummaryActivity? = nil
        ) -> ConversationSummary {
            ConversationSummary(
                id: id, kind: kind, parent: kind == .subagent ? 1 : nil, forkedAt: nil,
                title: title, status: status, updatedAt: now,
                label: label, role: role, activity: activity
            )
        }
        let tasks: [ConversationSummary] = [
            summary(2, .subagent, "Review the overview sheet", label: "Review overview sheet", status: .running,
                    role: "reviewer", activity: SummaryActivity(tool: "read", target: "OverviewSheet.swift")),
            summary(3, .subagent, "Run the iOS tests", label: "Run iOS tests", status: .running,
                    activity: SummaryActivity(tool: "bash", target: "xcodebuild test")),
            summary(4, .subagent, "Pick the branch icon", label: "Pick branch icon", status: .needsAnswer),
            summary(5, .subagent, "Check the Web card", label: "Compare with Web card", status: .running),
            summary(6, .subagent, "Draft the PR body", label: "Draft PR description"),
            summary(7, .subagent, "Screenshot light mode", label: "Capture light mode"),
            summary(8, .subagent, "Measure sheet height", label: "Measure sheet height", status: .failed),
        ]
        let root = summary(1, .conversation, "Overview sheet for the conversation page")
        let organized = Organized(
            chats: [],
            projects: [ProjectConversations(
                project: Project(path: projectPath, name: "pinomad", addedAt: now),
                conversations: [ConversationNode(
                    summary: root,
                    children: tasks.map { ConversationNode(summary: $0, children: []) }
                )]
            )],
            archived: []
        )
        let calls = tasks.map { task in
            let state: ToolPartState = switch task.status {
            case .running?, .needsAnswer?: .inputAvailable
            case .failed?: .outputError
            default: .outputAvailable
            }
            return ToolItem(
                state: state,
                argsText: #"{"task":"\#(task.label ?? "")"}"#,
                children: [], diffStat: nil, durationMs: nil, images: [],
                output: nil, toolCallId: "call-\(task.id ?? 0)", toolName: "subagent",
                pinomad: .subagent(
                    conversationId: task.id ?? 0, output: nil, model: nil,
                    startedAt: now - 120_000, endedAt: nil
                )
            )
        }
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: now - 120_000, elapsedMs: 120_000, todoWrittenAtMs: nil,
            steps: [.tools(id: "s1", tools: calls, live: false, activeToolCallId: nil)],
            answer: CotAnswer(text: "The subagents are running in the background; I'll summarize once their results are in.", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "Build the overview sheet, and spin off a few subagents to review and test it.", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: worktree),
            questions: [], todo: nil, home: .project(path: projectPath),
            checkout: WorktreeCheckout(
                conversationId: 1, path: worktree, repo: projectPath, subdir: "",
                branch: "pinomad/overview-sheet", base: "4e73cdb9a1f0c2d3", snapshot: nil
            ),
            busy: false, contextUsage: nil
        )
        func file(_ path: String, _ added: [String], _ removed: [String], isNew: Bool = false) -> PatchFile {
            let lines = [PatchLine(kind: .meta, text: "@@ -1,\(removed.count) +1,\(added.count) @@")]
                + removed.map { PatchLine(kind: .del, text: "-" + $0) }
                + added.map { PatchLine(kind: .add, text: "+" + $0) }
            return PatchFile(
                path: path, oldPath: nil, isNew: isNew, isDeleted: false, binary: false,
                additions: UInt64(added.count), deletions: UInt64(removed.count), lines: lines
            )
        }
        devChanges = .available(
            base: "4e73cdb9a1f0c2d3",
            files: [
                file("apps/ios/Pinomad/OverviewSheet.swift",
                     ["struct OverviewSheet: View {", "    let model: AppModel", "}"], [], isNew: true),
                file("apps/ios/Pinomad/ConversationView.swift",
                     ["Image(systemName: \"info.circle\")", ".accessibilityLabel(\"Overview\")"],
                     ["Image(systemName: \"plus.forwardslash.minus\")", ".accessibilityLabel(\"Changes\")"]),
                file("apps/ios/PinomadCore/Sources/PinomadChat/ChangesPanel.swift",
                     ["public mutating func observe(busy: Bool, connected: Bool) -> Token? {"],
                     ["public mutating func observe(busy: Bool) -> Token? {"]),
            ],
            truncated: truncated,
            branch: "pinomad/overview-sheet"
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false, protocolMismatch: nil,
            host: HostInfo(version: nil, protocol: ProtocolVersion(major: 5, minor: 14)),
            hostName: nil, settings: nil, devices: [], organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: conversation
        ))
        replyStreams.sync(chat: chat)
    }

    /// A settled run that ends in a pending question request. With no host
    /// behind it, Submit only shows its sending state.
    private func startQuestionDemo(_ mode: String) {
        navPath = [.conversation(1)]
        let now = Date.now.timeIntervalSince1970 * 1000
        let summary = ConversationSummary(
            id: 1, kind: .conversation, parent: nil, forkedAt: nil,
            title: "Upload endpoint auth", status: nil, updatedAt: now,
            label: nil, role: nil, activity: nil
        )
        let auth = QuestionItem(
            question: "The upload endpoint needs auth before it ships. Which approach should the new endpoint use? The phone already keeps a refresh token in its keychain.",
            header: "Auth method",
            options: [
                QuestionOption(label: "Bearer token (recommended)", description: "Exchange a short-lived access token through the existing refresh flow; the new endpoint has no CSRF surface."),
                QuestionOption(label: "Reuse session cookie", description: "Same middleware as the web client, but the phone has to manage cookies and CSRF."),
                QuestionOption(label: "Signed upload URLs", description: "The host signs each upload URL for ten minutes; the endpoint itself skips auth."),
            ],
            multiSelect: nil
        )
        let backfill = QuestionItem(
            question: "Existing records have no owner field. How should the migration backfill it?",
            header: "Migration",
            options: [
                QuestionOption(label: "Backfill from audit log", description: "Accurate for records created after March; older ones fall back to the workspace owner."),
                QuestionOption(label: "Assign all to workspace owner", description: nil),
            ],
            multiSelect: nil
        )
        let tests = QuestionItem(
            question: "Which layers of the new endpoint need test coverage? Pick any that apply.",
            header: "Test coverage",
            options: [
                QuestionOption(label: "Handler unit tests", description: nil),
                QuestionOption(label: "Protocol contract snapshot", description: "Re-record under packages/protocol/test/fixtures."),
                QuestionOption(label: "Playwright end-to-end", description: "Slowest; needs a real host running."),
            ],
            multiSelect: true
        )
        let rollout = QuestionItem(
            question: "Should this ship behind a flag?",
            header: "Rollout",
            options: [
                QuestionOption(label: "Add a flag, off by default", description: nil),
                QuestionOption(label: "Ship it directly", description: nil),
            ],
            multiSelect: nil
        )
        let request = mode == "single"
            ? QuestionRequest(id: "demo-single", questions: [rollout], askedAt: now, resolution: nil)
            : QuestionRequest(id: "demo-questions", questions: [auth, backfill, tests, rollout], askedAt: now, resolution: nil)
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: now - 6_000, elapsedMs: 6_000, todoWrittenAtMs: nil,
            steps: [],
            answer: CotAnswer(text: "A few things need your call before I start; the questions are below.", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "Add auth to the upload endpoint. Use your judgment, and ask me if you're unsure.", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: nil),
            questions: [PendingQuestion(kind: "ask_user_question", request: request)],
            todo: nil, home: nil, checkout: nil, busy: false, contextUsage: nil
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: mode == "offline" ? .reconnecting : .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, hostName: nil, settings: nil, devices: [],
            organized: Organized(
                chats: [ConversationNode(summary: summary, children: [])],
                projects: [], archived: []
            ),
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: conversation
        ))
        replyStreams.sync(chat: chat)
    }

    /// `PINOMAD_DEMO_CONTEXT=<used>/<window>` (anything else means nil)
    /// settles one conversation so the composer's context meter can be
    /// photographed without a host. The long model name also exercises the
    /// "capsule truncates first" layout next to the meter.
    private func startContextDemo(_ spec: String) {
        navPath = [.conversation(1)]
        let parts = spec.split(separator: "/")
        let usage: ContextUsage?
        if parts.count == 2, let used = Double(parts[0]), let window = Double(parts[1]) {
            usage = ContextUsage(used: used, window: window)
        } else {
            usage = nil
        }
        let ref = ModelRef(provider: "anthropic", modelId: "claude-sonnet-4-5-20250929")
        let model = ModelSummary(
            provider: ref.provider, modelId: ref.modelId,
            name: "Claude Sonnet 4.5 Extended Thinking Preview",
            contextWindow: usage?.window ?? 200_000,
            thinkingLevels: [.off, .medium, .high], images: true
        )
        let now = Date.now.timeIntervalSince1970 * 1000
        let parent = ConversationSummary(
            id: 1, kind: .conversation, parent: nil, forkedAt: nil,
            title: "Context usage demo", status: nil, updatedAt: now,
            label: nil, role: nil, activity: nil
        )
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: now - 4_000, elapsedMs: 4_000, todoWrittenAtMs: nil,
            steps: [],
            answer: CotAnswer(
                text: "Context usage is already computed in the core; the composer only draws it.",
                streaming: false
            )
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "How much context has this conversation used?", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: ref, thinkingLevel: .off, instructions: nil, cwd: nil),
            questions: [], todo: nil, home: nil, checkout: nil, busy: false, contextUsage: usage
        )
        drafts[1] = "Take a look at these changes"
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, hostName: nil, settings: nil, devices: [],
            organized: Organized(
                chats: [ConversationNode(summary: parent, children: [])],
                projects: [], archived: []
            ),
            notices: [], models: [model],
            defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: conversation
        ))
        replyStreams.sync(chat: chat)
    }

    /// Grows a live run by one step every two seconds (commands, a thinking
    /// step streaming in, and with `interims` a line to the user now and
    /// then) under a todo list half done, last written by the run before.
    private func startTraceDemo(interims: Bool) {
        navPath = [.conversation(1)]
        let start = Date.now.timeIntervalSince1970 * 1000
        let commands = ["bun run typecheck", "rg -n uploadQueue src", "bun test upload", "bun run lint"]
        let lines = [
            "Running the type check first to make sure the changes didn't break anything else.",
            "**Found it**: the upload queue reuses the same temp file name on retry.",
            "Naming it by attempt number instead, then rerunning the upload tests.",
        ]
        let todo = [
            TodoItem(text: "Reproduce the intermittent failure", status: .completed),
            TodoItem(text: "Add the attempt number to temp files", status: .completed),
            TodoItem(text: "Run the full suite and confirm it's stable", status: .inProgress),
            TodoItem(text: "Add a regression test", status: .pending),
        ]
        // A four-bar chart, small enough to inline.
        let chart = "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAs0lEQVR42u3QMQ3AIBAAQORUEzMiXgRymFGCA5ZK6IaCtqHpJafg0hHjIXOeLEm0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq06E2jc7TPES1atGjRokWLFi1atGjRokWLFi1atGjRokWLFi1a9H3RNSqLaNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNH/i+5ReIFo0aIRLVq0AtGiES1atAXRohEtWrQF0aIRvakLvqujxlgAdtAAAAAASUVORK5CYII="
        let earlier = CotView(
            phase: .settled, failed: false,
            anchorMs: start - 900_000, elapsedMs: 372_000, todoWrittenAtMs: start - 600_000,
            steps: [.tools(id: "e1", tools: (0..<3).map { index in
                ToolItem(
                    state: .outputAvailable, argsText: "rg -n flaky src/upload\(index).ts", children: [],
                    diffStat: nil, durationMs: 800, images: [], output: "ok",
                    toolCallId: "e1-\(index)", toolName: "bash", pinomad: nil
                )
            }, live: false, activeToolCallId: nil),
            // A result carrying an image, to open it full screen from the
            // trace sheet.
            .tools(id: "e2", tools: [ToolItem(
                state: .outputAvailable, argsText: "coverage/flaky-runs.png", children: [],
                diffStat: nil, durationMs: 300, images: [MessageImage(data: chart, mimeType: "image/png")],
                output: "Read image coverage/flaky-runs.png", toolCallId: "e2-0", toolName: "read", pinomad: nil
            )], live: false, activeToolCallId: nil)],
            answer: CotAnswer(text: "The cause is a temp file name collision on retry. I've written up a plan and will fix it next.", streaming: false)
        )
        Task { [weak self] in
            var steps: [CotStep] = []
            for tick in 0..<150 {
                guard let self, !Task.isCancelled else { return }
                // Settle what the last tick left live.
                steps = steps.map { step in
                    switch step {
                    case let .thinking(id, text, _):
                        return .thinking(id: id, text: text, live: false)
                    case let .tools(id, tools, _, _):
                        return .tools(id: id, tools: tools.map { tool in
                            var done = tool
                            done.state = .outputAvailable
                            done.output = "ok"
                            done.durationMs = 1_200
                            return done
                        }, live: false, activeToolCallId: nil)
                    case .interim:
                        return step
                    }
                }
                if interims, tick % 4 == 1 {
                    steps.append(.interim(id: "i\(tick)", text: lines[(tick / 4) % lines.count]))
                } else if tick % 4 == 3 {
                    steps.append(.thinking(id: "t\(tick)", text: "Check the output for new failures, then decide whether to narrow the scope next.", live: true))
                } else {
                    let command = commands[tick % commands.count]
                    steps.append(.tools(id: "s\(tick)", tools: [ToolItem(
                        state: .inputAvailable, argsText: command, children: [], diffStat: nil,
                        durationMs: nil, images: [], output: nil, toolCallId: "c\(tick)",
                        toolName: "bash", pinomad: nil
                    )], live: true, activeToolCallId: "c\(tick)"))
                }
                let live = CotView(
                    phase: .acting, failed: false, anchorMs: start, elapsedMs: nil,
                    todoWrittenAtMs: nil, steps: steps, answer: nil
                )
                let chat: [ChatEntry] = [
                    .user(id: "u1", text: "The upload tests fail now and then. Can you look into it?", images: []),
                    .run(id: "run-1", cot: earlier, forkEntryId: nil, interrupted: false, failure: nil),
                    .user(id: "u2", text: "Fix it per the plan, and keep the changes small.", images: []),
                    .run(id: "run-2", cot: live, forkEntryId: nil, interrupted: false, failure: nil),
                ]
                let conversation = ConversationSnapshot(
                    id: 1, chat: chat, statusText: "", queueItems: [],
                    agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: nil),
                    questions: [], todo: todo, home: nil, checkout: nil, busy: true, contextUsage: nil
                )
                self.publishDevSnapshot(ClientSnapshot(
                    version: UInt64(tick + 1), connection: .connected, unauthorized: false,
                    protocolMismatch: nil, host: nil, hostName: nil, settings: nil, devices: [],
                    organized: Organized(chats: [], projects: [], archived: []),
                    notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
                    agents: nil, conversation: conversation
                ))
                self.replyStreams.sync(chat: chat)
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func demoPublish(answer: String, streaming: Bool, version: inout UInt64) {
        version += 1
        let cot = CotView(
            phase: streaming ? .answering : .settled, failed: false,
            anchorMs: nil, elapsedMs: nil, todoWrittenAtMs: nil, steps: [],
            answer: CotAnswer(text: answer, streaming: streaming)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "Demo one round of streaming output", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conv = ConversationSnapshot(
            id: 1, chat: chat, statusText: streaming ? "Responding…" : "",
            queueItems: [], agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: nil),
            questions: [], todo: nil, home: nil, checkout: nil, busy: streaming, contextUsage: nil
        )
        publishDevSnapshot(ClientSnapshot(
            version: version, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, hostName: nil, settings: nil, devices: [],
            organized: Organized(chats: [], projects: [], archived: []),
            notices: [], models: [],
            defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil,
            conversation: conv
        ))
        replyStreams.sync(chat: chat)
    }
}
#endif
