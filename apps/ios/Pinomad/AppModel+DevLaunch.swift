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
        这是一段流式输出的演示。**Markdown** 会逐词显现，应该能看到淡入效果。

        ## 小节标题

        - 列表项一：内容逐渐增长
        - 列表项二：接着出现
        - 列表项三：验证节奏

        ```swift
        let stream = StreamingMarkdown()
        stream.append("hello")
        ```

        一段收尾的正文，到这里回答就基本结束了。
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
            title: "发版前的检查", status: nil, updatedAt: now,
            label: nil, role: nil, activity: nil
        )
        let reviewed = ConversationSummary(
            id: 2, kind: .subagent, parent: 1, forkedAt: nil,
            title: "Review the auth middleware", status: nil, updatedAt: now,
            label: "审查登录中间件", role: "reviewer", activity: nil
        )
        let plain = ConversationSummary(
            id: 3, kind: .subagent, parent: 1, forkedAt: nil,
            title: "Write the release notes", status: nil, updatedAt: now,
            label: "整理发布说明", role: nil, activity: nil
        )
        let organized = Organized(
            chats: [ConversationNode(summary: parent, children: [
                ConversationNode(summary: reviewed, children: []),
                ConversationNode(summary: plain, children: []),
            ])],
            projects: [], archived: []
        )
        let reviewOutput = "登录中间件没有发现鉴权绕过；建议把会话过期时间写进配置。"
        let notesOutput = "发布说明已按「新增 / 修复 / 升级注意」整理。"
        let tools = [
            ToolItem(
                state: .outputAvailable,
                argsText: #"{"task":"审查登录中间件","description":"审查登录中间件"}"#,
                children: [], diffStat: nil, durationMs: nil, images: [],
                output: reviewOutput, toolCallId: "call-review", toolName: "subagent",
                pinomad: .subagent(
                    conversationId: 2, output: reviewOutput, model: "anthropic/claude-x",
                    startedAt: now - 65_000, endedAt: now
                )
            ),
            ToolItem(
                state: .outputAvailable,
                argsText: #"{"task":"整理发布说明","description":"整理发布说明"}"#,
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
            answer: CotAnswer(text: "两个子代理都完成了：登录中间件没有发现问题，发布说明已按分类整理。", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "发版前帮我检查登录中间件并整理发布说明。", images: []),
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
            summary(2, .subagent, "Review the overview sheet", label: "审查概览 sheet", status: .running,
                    role: "reviewer", activity: SummaryActivity(tool: "read", target: "OverviewSheet.swift")),
            summary(3, .subagent, "Run the iOS tests", label: "跑 iOS 测试", status: .running,
                    activity: SummaryActivity(tool: "bash", target: "xcodebuild test")),
            summary(4, .subagent, "Pick the branch icon", label: "挑分支图标", status: .needsAnswer),
            summary(5, .subagent, "Check the Web card", label: "对照 Web 卡片", status: .running),
            summary(6, .subagent, "Draft the PR body", label: "起草 PR 说明"),
            summary(7, .subagent, "Screenshot light mode", label: "截浅色模式"),
            summary(8, .subagent, "Measure sheet height", label: "量 sheet 高度", status: .failed),
        ]
        let root = summary(1, .conversation, "对话页的概览 sheet")
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
            answer: CotAnswer(text: "子代理在后台跑着，结果回来后我再汇总。", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "把概览 sheet 做出来，顺便分几个子代理去审查和测试。", images: []),
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
                     ["Image(systemName: \"info.circle\")", ".accessibilityLabel(\"概览\")"],
                     ["Image(systemName: \"plus.forwardslash.minus\")", ".accessibilityLabel(\"改动\")"]),
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
            title: "上传接口鉴权", status: nil, updatedAt: now,
            label: nil, role: nil, activity: nil
        )
        let auth = QuestionItem(
            question: "上传接口要先加鉴权才能发布。新接口用哪种方式？手机端的钥匙串里已经存着 refresh token。",
            header: "鉴权方式",
            options: [
                QuestionOption(label: "Bearer token（推荐）", description: "从现有的刷新流程换短期 access token，新接口没有 CSRF 面。"),
                QuestionOption(label: "复用会话 cookie", description: "和 Web 端同一套中间件，但手机端要管 cookie 和 CSRF。"),
                QuestionOption(label: "签名上传地址", description: "宿主给每个上传地址签十分钟，接口本身不鉴权。"),
            ],
            multiSelect: nil
        )
        let backfill = QuestionItem(
            question: "现有数据没有 owner 字段，迁移时怎么回填？",
            header: "迁移方案",
            options: [
                QuestionOption(label: "从审计日志回填", description: "三月之后创建的数据准确；更早的回退到工作区所有者。"),
                QuestionOption(label: "统一归给工作区所有者", description: nil),
            ],
            multiSelect: nil
        )
        let tests = QuestionItem(
            question: "新接口要哪些层的测试覆盖？可以多选。",
            header: "测试覆盖",
            options: [
                QuestionOption(label: "处理函数单元测试", description: nil),
                QuestionOption(label: "协议契约快照", description: "在 packages/protocol/test/fixtures 下重录。"),
                QuestionOption(label: "Playwright 端到端", description: "最慢，需要起真实宿主。"),
            ],
            multiSelect: true
        )
        let rollout = QuestionItem(
            question: "要不要放在开关后面发布？",
            header: "发布顺序",
            options: [
                QuestionOption(label: "加开关，默认关闭", description: nil),
                QuestionOption(label: "直接发布", description: nil),
            ],
            multiSelect: nil
        )
        let request = mode == "single"
            ? QuestionRequest(id: "demo-single", questions: [rollout], askedAt: now, resolution: nil)
            : QuestionRequest(id: "demo-questions", questions: [auth, backfill, tests, rollout], askedAt: now, resolution: nil)
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: now - 6_000, elapsedMs: 6_000, todoWrittenAtMs: nil,
            steps: [],
            answer: CotAnswer(text: "动手之前有几件事需要你拍板，问题在下面。", streaming: false)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "上传接口要加鉴权，你看着办，拿不准的问我。", images: []),
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
            title: "上下文用量演示", status: nil, updatedAt: now,
            label: nil, role: nil, activity: nil
        )
        let cot = CotView(
            phase: .settled, failed: false, anchorMs: now - 4_000, elapsedMs: 4_000, todoWrittenAtMs: nil,
            steps: [],
            answer: CotAnswer(
                text: "上下文用量已经算在核心里，composer 只负责把它画出来。",
                streaming: false
            )
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "这个对话用了多少上下文？", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conversation = ConversationSnapshot(
            id: 1, chat: chat, statusText: "", queueItems: [],
            agent: AgentState(model: ref, thinkingLevel: .off, instructions: nil, cwd: nil),
            questions: [], todo: nil, home: nil, checkout: nil, busy: false, contextUsage: usage
        )
        drafts[1] = "帮我看看这个改动"
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
            "先跑一遍类型检查，确认改动没有带坏别的地方。",
            "**找到了**：上传队列在重试时复用了同一个临时文件名。",
            "改成按尝试次数命名，再跑一次上传测试。",
        ]
        let todo = [
            TodoItem(text: "复现偶发失败", status: .completed),
            TodoItem(text: "给临时文件加上尝试序号", status: .completed),
            TodoItem(text: "跑完整测试并确认稳定", status: .inProgress),
            TodoItem(text: "补一条回归测试", status: .pending),
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
            answer: CotAnswer(text: "原因是重试时临时文件名冲突，我列了一个计划，接下来按计划修。", streaming: false)
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
                    steps.append(.thinking(id: "t\(tick)", text: "看一下输出里有没有新的失败，再决定下一步要不要缩小范围。", live: true))
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
                    .user(id: "u1", text: "上传测试偶尔会失败，帮我查一下。", images: []),
                    .run(id: "run-1", cot: earlier, forkEntryId: nil, interrupted: false, failure: nil),
                    .user(id: "u2", text: "按计划修掉，改动尽量小。", images: []),
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
            .user(id: "u1", text: "演示一轮流式输出", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conv = ConversationSnapshot(
            id: 1, chat: chat, statusText: streaming ? "正在输出…" : "",
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
