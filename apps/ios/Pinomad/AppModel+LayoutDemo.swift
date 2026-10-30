#if DEBUG
import Foundation
import PinomadCore

/// `PINOMAD_DEMO_LAYOUT`: the conversation list grouped by machine, without
/// a host — three paired machines: the first with chats, two projects, a
/// family whose subagents roll up into its row and one archived root; the
/// second with a chat and a project; the third still connecting. `old`
/// connects the first as a 5.2 host, which has no folder picker; `offline`
/// fails the third instead. `draft`, `settings` and `tile` open the first
/// machine's draft, Settings, or the cross-machine Needs Answer list.
extension AppModel {
    func startLayoutDemo(_ mode: String) {
        useDevHosts(StoredHosts(
            hosts: [
                HostRecord(url: "ws://mbp:7777", hostKey: "demo-mbp", privateKey: "", name: "mbp"),
                HostRecord(url: "ws://omarchy:7777", hostKey: "demo-omarchy", privateKey: "", name: "omarchy"),
                HostRecord(url: "ws://studio:7777", hostKey: "demo-studio", privateKey: "", name: "studio"),
            ],
            activeHostKey: "demo-mbp"
        ))
        let now = Date.now.timeIntervalSince1970 * 1000
        let minute = 60_000.0
        func summary(
            _ id: UInt64, _ title: String, kind: SummaryKind = .conversation, parent: UInt64? = nil,
            status: ConversationStatus? = nil, ago: Double
        ) -> ConversationSummary {
            ConversationSummary(
                id: id, kind: kind, parent: parent, forkedAt: nil, title: title, status: status,
                updatedAt: now - ago * minute, label: nil, role: nil, activity: nil
            )
        }
        func node(_ summary: ConversationSummary, _ children: [ConversationNode] = []) -> ConversationNode {
            ConversationNode(summary: summary, children: children)
        }
        let reviewers = [
            node(summary(11, "reviewer", kind: .subagent, parent: 10, status: .running, ago: 0.5)),
            node(summary(12, "tests", kind: .subagent, parent: 10, ago: 3)),
            node(summary(13, "docs", kind: .subagent, parent: 10, ago: 4)),
        ]
        let organized = Organized(
            chats: [
                node(summary(1, "Weekly report draft", ago: 2)),
                node(summary(2, "AirPods noise cancelling comparison", ago: 180)),
                node(summary(3, "Itinerary for next week's Hangzhou trip", status: .needsAnswer, ago: 40)),
            ],
            projects: [
                ProjectConversations(
                    project: Project(path: "/Users/void/code/opensource/pinomad", name: "pinomad", addedAt: now),
                    conversations: [
                        node(summary(10, "Fix hostLabels collision suffix", status: .running, ago: 0.5), reviewers),
                        node(summary(20, "Revoke confirmation copy on Devices", status: .needsAnswer, ago: 12)),
                        node(summary(21, "Upgrade @earendil-works to 1.2.0", ago: 60)),
                        node(summary(22, "Group iOS list by machine", status: .running, ago: 1)),
                        node(summary(23, "Triage dureview comments", status: .needsAnswer, ago: 25)),
                        node(summary(24, "Backoff for relay reconnects", ago: 240)),
                    ]
                ),
                ProjectConversations(
                    project: Project(path: "/Users/void/code/opensource/AgentChatKit", name: "AgentChatKit", addedAt: now),
                    conversations: [
                        node(summary(30, "Streaming Markdown fade-in", status: .failed, ago: 300)),
                        node(summary(31, "Long list scroll jank", ago: 1_500)),
                    ]
                ),
            ],
            archived: [
                ArchivedConversation(node: node(summary(40, "Old pairing flow", ago: 9_000)), project: nil),
            ]
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil,
            host: HostInfo(version: nil, protocol: ProtocolVersion(major: 5, minor: mode == "old" ? 2 : 14)),
            hostName: "mbp", settings: nil, devices: [],
            organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: nil
        ), on: "demo-mbp")
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil,
            host: HostInfo(version: nil, protocol: ProtocolVersion(major: 5, minor: 14)),
            hostName: "omarchy", settings: nil, devices: [],
            organized: Organized(
                chats: [node(summary(50, "Hyprland window rules", status: .running, ago: 3))],
                projects: [
                    ProjectConversations(
                        project: Project(path: "/home/kieran/Projects/dotfiles", name: "dotfiles", addedAt: now),
                        conversations: [
                            node(summary(60, "Waybar battery module", status: .needsAnswer, ago: 8)),
                            node(summary(61, "Migrate to foot terminal", ago: 2_000)),
                        ]
                    ),
                ],
                archived: []
            ),
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: nil
        ), on: "demo-omarchy")
        if mode == "offline" {
            failDevHost("demo-studio", .unreachable("Couldn't reach studio:7777."))
        }
        switch mode {
        case "draft": navPath = [.newConversation(hostKey: "demo-mbp")]
        case "settings": navPath = [.settings]
        case "tile": navPath = [.conversations(hostKey: nil, filter: .needsAnswer)]
        default: break
        }
    }
}
#endif
