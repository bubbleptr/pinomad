#if DEBUG
import Foundation
import PinomadCore

/// `PINOMAD_DEMO_SETTINGS`: the settings pages without a host — two paired
/// machines (the first connected, renamed, with three devices, this one
/// among them), a chat, and one archived root. `failed`
/// shows the first machine's failure page instead; `account` adds a
/// signed-in account (its calls never leave the app). The addresses are
/// `.invalid` and the injected hosts block switching and forgetting, so
/// nothing reaches the keychain or the network.
extension AppModel {
    func startSettingsDemo(_ mode: String) {
        // A fixed key, so the devices list can mark this device.
        let privateKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        useDevHosts(StoredHosts(
            hosts: [
                HostRecord(url: "ws://mbp.invalid:7777", hostKey: "demo-mbp", privateKey: privateKey, name: "mbp"),
                HostRecord(url: "ws://omarchy.invalid:7777", hostKey: "demo-omarchy", privateKey: "", name: "omarchy"),
            ],
            activeHostKey: "demo-mbp"
        ))
        if mode == "account" {
            accountRecord = AccountRecord(
                serverOrigin: "https://accounts.invalid", username: "kieran",
                token: "demo", expiresAt: Date.now.addingTimeInterval(86_400).timeIntervalSince1970 * 1000)
        }
        if mode == "failed" {
            phase = .failed(.unreachable("连不上 mbp.invalid:7777。"))
            return
        }
        let now = Date.now.timeIntervalSince1970 * 1000
        func summary(_ id: UInt64, _ title: String, ago minutes: Double) -> ConversationSummary {
            ConversationSummary(
                id: id, kind: .conversation, parent: nil, forkedAt: nil, title: title, status: nil,
                updatedAt: now - minutes * 60_000, label: nil, role: nil, activity: nil
            )
        }
        let organized = Organized(
            chats: [ConversationNode(summary: summary(1, "周报整理", ago: 2), children: [])],
            projects: [],
            archived: [
                ArchivedConversation(
                    node: ConversationNode(summary: summary(40, "旧的配对流程", ago: 9_000), children: []),
                    project: Project(path: "/Users/void/code/opensource/pinomad", name: "pinomad", addedAt: now)),
            ]
        )
        phase = .connected
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: HostInfo(version: "0.9.0", protocol: ProtocolVersion(major: 5, minor: 14)),
            hostName: "studio",
            settings: HostSettingsState(acceptAccountDevices: true, hostNameCustom: true),
            devices: [
                DeviceEntry(publicKey: devicePublicKey(privateKey: privateKey) ?? "", name: "iPhone",
                            pairedAt: now - 3 * 86_400_000, source: .qr),
                DeviceEntry(publicKey: "demo-mac", name: "Kieran 的 MacBook", pairedAt: now - 40 * 86_400_000,
                            source: .local),
                DeviceEntry(publicKey: "demo-ipad", name: "iPad", pairedAt: now - 2 * 3_600_000, source: .account),
            ],
            organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: nil
        ))
    }
}
#endif
