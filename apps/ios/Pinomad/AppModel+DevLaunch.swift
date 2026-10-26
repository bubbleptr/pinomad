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
        // The simulator end-to-end seam: attach one file from the app
        // container after pairing, then create the draft once it uploaded.
        if let file = env["PINOMAD_ATTACH_FILE"] {
            pendingAttachFile = file
            pendingAttachSend = env["PINOMAD_AUTOSEND"] != nil
        }
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
            // The overview's context row at a scripted usage, for
            // screenshots on a simulator that cannot reach a host.
            phase = .connected
            startContextDemo(context)
            return true
        }
        if let mode = env["PINOMAD_DEMO_FILES"] {
            // File chips in the draft composer, or sent files in a bubble,
            // without a host — the three upload states for the screenshots.
            startFilesDemo(mode)
            return true
        }
        if let mode = env["PINOMAD_DEMO_AGENT"] {
            // The conversation model sheet's pickable Agent section on a
            // 5.18 host: `missing` keeps a since-removed agent selected,
            // `none` starts without one.
            phase = .connected
            startAgentDemo(mode)
            return true
        }
        if let mode = env["PINOMAD_DEMO_MODELS"] {
            // The model capsule and sheet with makers' logos; `sheet` opens
            // the sheet over the conversation.
            phase = .connected
            startModelsDemo(sheet: mode == "sheet")
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

    /// Attach the injected file once the session is ready, then (when
    /// `PINOMAD_AUTOSEND` is set) create the draft after its upload settles.
    /// This drives the real upload and send paths; only the picker tap is
    /// skipped, because simctl has no file-picker automation.
    func consumeDevAttachRequest() {
        guard let path = pendingAttachFile else { return }
        pendingAttachFile = nil
        let url = URL(fileURLWithPath: path)
        guard let data = try? Data(contentsOf: url) else {
            showToast("Dev attach file is unreadable", level: "error")
            return
        }
        navPath = [.newConversation]
        let key = Self.draftKey
        let name = url.lastPathComponent
        Task { [weak self] in
            // Ready arrives before the first view, so the host's version is
            // not known yet; wait for the 5.19 announcement before attaching.
            for _ in 0..<150 {
                guard let self else { return }
                if self.hostSupports(.attachments) {
                    self.attachFileData(conversation: key, name: name, data: data)
                    self.attachAfterUploadIfNeeded(key: key)
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func attachAfterUploadIfNeeded(key: UInt64) {
        guard pendingAttachSend else { return }
        Task { [weak self] in
            for _ in 0..<150 {
                guard let self else { return }
                if let tray = self.fileTrays[key], !tray.isEmpty, tray.canSend,
                   self.snapshot?.organized != nil {
                    self.pendingAttachSend = false
                    await self.createConversation()
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    /// `PINOMAD_DEMO_FILES=uploading|done|failed|all|bubble`: a draft with
    /// staged file chips, or a sent message with attachment chips.
    private func startFilesDemo(_ mode: String) {
        phase = .connected
        let host = HostInfo(version: "5.19.0", protocol: ProtocolVersion(major: 5, minor: 19))
        let ref = ModelRef(provider: "faux", modelId: "faux-1")
        let model = ModelSummary(
            provider: ref.provider, modelId: ref.modelId, name: "Faux Model",
            contextWindow: 200_000, thinkingLevels: [.off], images: true
        )
        let defaults = Defaults(model: ref, thinkingLevel: .off)

        if mode == "bubble" || mode == "queue" {
            let attachments = [
                UserAttachment(id: String(repeating: "A", count: 22), name: "parser.patch", size: 2_048),
                UserAttachment(id: String(repeating: "B", count: 22), name: "build.log", size: 8_192),
            ]
            let now = Date.now.timeIntervalSince1970 * 1000
            let summary = ConversationSummary(
                id: 1, kind: .conversation, parent: nil, forkedAt: nil,
                title: "Parser regression", status: nil, updatedAt: now,
                label: nil, role: nil, activity: nil
            )
            let chat: [ChatEntry] = [
                .user(id: "u1", text: "The parser regression is in this patch and log.",
                      images: [], skills: [], attachments: attachments),
            ]
            let queue = mode == "queue"
                ? [QueueItem(id: 1, mode: .followUp, text: "Then check the release notes",
                             imageCount: 0, attachmentCount: 2)]
                : []
            let conversation = ConversationSnapshot(
                id: 1, chat: chat, statusText: "", queueItems: queue,
                agent: AgentState(model: ref, thinkingLevel: .off, instructions: nil, cwd: nil),
                questions: [], todo: nil, home: nil, checkout: nil, busy: mode == "queue",
                contextUsage: nil, fresh: true, freshEpoch: 1
            )
            navPath = [.conversation(1)]
            publishDevSnapshot(ClientSnapshot(
                version: 1, connection: .connected, unauthorized: false,
                protocolMismatch: nil, host: host, hostName: nil, settings: nil, devices: [],
                organized: Organized(
                    chats: [ConversationNode(summary: summary, children: [])],
                    projects: [], archived: []
                ),
                notices: [], models: [model], defaults: defaults,
                agents: nil, conversation: conversation
            ))
            replyStreams.sync(chat: chat)
            return
        }

        navPath = [.newConversation]
        drafts[Self.draftKey] = "Check these files before I send them."
        var tray = FileAttachmentTray()
        func source(_ name: String, _ size: Int) -> FileAttachmentSource {
            FileAttachmentSource(name: name, data: Data(repeating: 0x41, count: size))
        }
        switch mode {
        case "uploading":
            let uploading = tray.add([source("parser.patch", 2_048)])[0]
            tray.progress(id: uploading.id, received: 900, complete: false)
            let done = tray.add([source("release-notes.md", 12_345)])[0]
            tray.finish(id: done.id, attachmentId: String(repeating: "A", count: 22),
                        received: 12_345)
        case "done":
            let done = tray.add([source("release-notes.md", 12_345)])[0]
            tray.finish(id: done.id, attachmentId: String(repeating: "A", count: 22),
                        received: 12_345)
        case "failed":
            let failed = tray.add([source("build.log", 8_192)])[0]
            tray.fail(id: failed.id, error: "host offline")
        default:
            let uploading = tray.add([source("parser.patch", 2_048)])[0]
            tray.progress(id: uploading.id, received: 900, complete: false)
            let done = tray.add([source("release-notes.md", 12_345)])[0]
            tray.finish(id: done.id, attachmentId: String(repeating: "A", count: 22),
                        received: 12_345)
            let failed = tray.add([source("build.log", 8_192)])[0]
            tray.fail(id: failed.id, error: "host offline")
        }
        fileTrays[Self.draftKey] = tray
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: host, hostName: nil, settings: nil, devices: [],
            organized: Organized(chats: [], projects: [], archived: []),
            notices: [], models: [model], defaults: defaults,
            agents: nil, conversation: nil
        ))
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
            questions: [], todo: nil, home: nil, checkout: nil, busy: false, contextUsage: nil, fresh: true, freshEpoch: 1
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
            busy: false, contextUsage: nil, fresh: true, freshEpoch: 1
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
            todo: nil, home: nil, checkout: nil, busy: false, contextUsage: nil, fresh: true, freshEpoch: 1
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
    /// settles one conversation so the overview's context row can be
    /// photographed without a host.
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
            questions: [], todo: nil, home: nil, checkout: nil, busy: false, contextUsage: usage, fresh: true, freshEpoch: 1
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

    /// `PINOMAD_DEMO_AGENT`: a 5.18 host with two roles and a top-level
    /// conversation, so the model sheet's Agent picker can be photographed
    /// without a live host. `missing` selects a role the host no longer
    /// offers; `none` has no current agent.
    private func startAgentDemo(_ mode: String) {
        navPath = [.conversation(1)]
        let now = Date.now.timeIntervalSince1970 * 1000
        let gpt = ModelRef(provider: "openai", modelId: "gpt-5")
        let models = [
            ModelSummary(provider: "openai", modelId: "gpt-5", name: "GPT-5",
                         contextWindow: 200_000,
                         thinkingLevels: [.off, .low, .medium, .high], images: true),
            ModelSummary(provider: "anthropic", modelId: "sonnet", name: "Sonnet",
                         contextWindow: 200_000,
                         thinkingLevels: [.off, .low, .medium], images: true),
        ]
        let roles = [
            AgentRole(name: "reviewer", description: "Reviews code and tests",
                      model: "openai/gpt-5", thinkingLevel: .high, prompt: "Review."),
            AgentRole(name: "planner", description: "Plans the work before coding",
                      model: "anthropic/sonnet", thinkingLevel: .medium, prompt: "Plan."),
        ]
        let current: String? = switch mode {
        case "missing": "removed"
        case "none": nil
        default: "reviewer"
        }
        let summary = ConversationSummary(
            id: 1, kind: .conversation, parent: nil, forkedAt: nil,
            title: "Review the parser change", status: nil, updatedAt: now,
            label: nil, role: "reviewer", currentAgent: current, activity: nil
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "Review the parser change before I merge it.", images: []),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: gpt, thinkingLevel: .high, instructions: nil, cwd: nil),
            questions: [], todo: nil, home: nil, checkout: nil, busy: false,
            contextUsage: nil, fresh: true, freshEpoch: 1
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil,
            host: HostInfo(version: "5.18.0", protocol: ProtocolVersion(major: 5, minor: 18)),
            hostName: "Demo Mac", settings: nil, devices: [],
            organized: Organized(chats: [ConversationNode(summary: summary, children: [])],
                                 projects: [], archived: []),
            notices: [], models: models, defaults: Defaults(model: gpt, thinkingLevel: .low),
            agents: AgentRoles(roles: roles, problems: []), conversation: conversation
        ))
        replyStreams.sync(chat: chat)
        devShowsModelSheet = true
    }

    /// `PINOMAD_DEMO_MODELS`: models from many makers, some served by
    /// another provider (Claude on Copilot and Bedrock) and one with no
    /// logo, so the capsule and the sheet's logos can be photographed
    /// without a live host. The capsule shows GPT-5, a monochrome logo
    /// that takes the text's color; the sheet opens on Claude. The settled
    /// run was Claude's, so its trace keeps Claude's logo.
    private func startModelsDemo(sheet: Bool) {
        navPath = [.conversation(1)]
        let now = Date.now.timeIntervalSince1970 * 1000
        let levels: [ThinkingLevel] = [.off, .low, .medium, .high]
        let entries: [(provider: String, modelId: String, name: String, reasons: Bool)] = [
            ("github-copilot", "claude-sonnet-4.5", "Claude Sonnet 4.5", true),
            ("amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0", "Claude Opus 4.1", true),
            ("openai", "gpt-5", "GPT-5", true),
            ("github-copilot", "o4-mini", "o4-mini", true),
            ("google", "gemini-2.5-pro", "Gemini 2.5 Pro", true),
            ("openrouter", "google/gemma-3-27b-it", "Gemma 3 27B", false),
            ("xai", "grok-4", "Grok 4", true),
            ("openrouter", "moonshotai/kimi-k2", "Kimi K2", false),
            ("groq", "deepseek-r1-distill-llama-70b", "DeepSeek R1 Distill Llama 70B", true),
            ("openrouter", "qwen/qwen3-coder", "Qwen3 Coder", false),
            ("mistral", "devstral-medium-latest", "Devstral Medium", false),
            ("openrouter", "microsoft/phi-4", "Phi 4", false),
            ("custom-lab", "house-model", "House Model", false),
        ]
        let models = entries.map {
            ModelSummary(provider: $0.provider, modelId: $0.modelId, name: $0.name,
                         contextWindow: 200_000, thinkingLevels: $0.reasons ? levels : [], images: true)
        }
        let picked = entries[sheet ? 0 : 2]
        let current = ModelRef(provider: picked.provider, modelId: picked.modelId)
        let summary = ConversationSummary(
            id: 1, kind: .conversation, parent: nil, forkedAt: nil,
            title: "Pick a model", status: nil, updatedAt: now,
            label: nil, role: nil, currentAgent: nil, activity: nil
        )
        let read = ToolItem(
            state: .outputAvailable, argsText: #"{"path":"src/parser.ts"}"#,
            children: [], diffStat: nil, durationMs: nil, images: [],
            output: "export function parse() {}", toolCallId: "c1", toolName: "read", pinomad: nil
        )
        let cot = CotView(
            phase: .settled, failed: false,
            anchorMs: now - 42_000, elapsedMs: 42_000, todoWrittenAtMs: nil,
            model: ModelRef(provider: entries[0].provider, modelId: entries[0].modelId),
            steps: [.tools(id: "s1", tools: [read], live: false, activeToolCallId: nil)],
            answer: CotAnswer(text: "The parser change is small enough for any of them; GPT-5 is a good second opinion.", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "Which model should review the parser change?", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: current, thinkingLevel: .medium, instructions: nil, cwd: nil),
            questions: [], todo: nil, home: nil, checkout: nil, busy: false,
            contextUsage: nil, fresh: true, freshEpoch: 1
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, hostName: "Demo Mac", settings: nil, devices: [],
            organized: Organized(chats: [ConversationNode(summary: summary, children: [])],
                                 projects: [], archived: []),
            notices: [], models: models, defaults: Defaults(model: current, thinkingLevel: .medium),
            agents: nil, conversation: conversation
        ))
        replyStreams.sync(chat: chat)
        devShowsModelSheet = sheet
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
                    questions: [], todo: todo, home: nil, checkout: nil, busy: true, contextUsage: nil, fresh: true, freshEpoch: 1
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
            questions: [], todo: nil, home: nil, checkout: nil, busy: streaming, contextUsage: nil, fresh: true, freshEpoch: 1
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
