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
            anchorMs: now - 90_000, elapsedMs: 90_000,
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
            questions: [], home: nil, checkout: nil, busy: false
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: conversation
        ))
        replyStreams.sync(chat: chat)
    }

    private func demoPublish(answer: String, streaming: Bool, version: inout UInt64) {
        version += 1
        let cot = CotView(
            phase: streaming ? .answering : .settled, failed: false,
            anchorMs: nil, elapsedMs: nil, steps: [],
            answer: CotAnswer(text: answer, streaming: streaming)
        )
        let chat: [ChatEntry] = [
            .user(id: "u1", text: "演示一轮流式输出", images: []),
            .run(id: "run-demo", cot: cot, forkEntryId: nil, interrupted: false, failure: nil),
        ]
        let conv = ConversationSnapshot(
            id: 1, chat: chat, statusText: streaming ? "正在输出…" : "",
            queueItems: [], agent: AgentState(model: nil, thinkingLevel: nil, instructions: nil, cwd: nil),
            questions: [], home: nil, checkout: nil, busy: streaming
        )
        publishDevSnapshot(ClientSnapshot(
            version: version, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil,
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
