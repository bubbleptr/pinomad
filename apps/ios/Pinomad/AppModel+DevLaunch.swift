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
