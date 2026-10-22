#if DEBUG
import Foundation
import PinomadCore

/// `PINOMAD_DEMO_LAYOUT`: the conversation list grouped by machine, without
/// a host — two paired machines (the first connected), chats, two projects,
/// a family whose subagents roll up into its row, and one archived root.
extension AppModel {
    func startLayoutDemo() {
        useDevHosts(StoredHosts(
            hosts: [
                HostRecord(url: "ws://mbp:7777", hostKey: "demo-mbp", privateKey: "", name: "mbp"),
                HostRecord(url: "ws://omarchy:7777", hostKey: "demo-omarchy", privateKey: "", name: "omarchy"),
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
                node(summary(1, "周报整理", ago: 2)),
                node(summary(2, "AirPods 降噪对比", ago: 180)),
                node(summary(3, "下周去杭州的行程", status: .needsAnswer, ago: 40)),
            ],
            projects: [
                ProjectConversations(
                    project: Project(path: "/Users/void/code/opensource/pinomad", name: "pinomad", addedAt: now),
                    conversations: [
                        node(summary(10, "修复 hostLabels 冲突后缀", status: .running, ago: 0.5), reviewers),
                        node(summary(20, "设备页的吊销确认文案", status: .needsAnswer, ago: 12)),
                        node(summary(21, "升级 @earendil-works 到 1.2.0", ago: 60)),
                        node(summary(22, "iOS 列表页按机器分组", status: .running, ago: 1)),
                        node(summary(23, "dureview 评审意见分拣", status: .needsAnswer, ago: 25)),
                        node(summary(24, "中继断线重连的退避", ago: 240)),
                    ]
                ),
                ProjectConversations(
                    project: Project(path: "/Users/void/code/opensource/AgentChatKit", name: "AgentChatKit", addedAt: now),
                    conversations: [
                        node(summary(30, "流式 Markdown 的淡入", status: .failed, ago: 300)),
                        node(summary(31, "长列表滚动卡顿", ago: 1_500)),
                    ]
                ),
            ],
            archived: [
                ArchivedConversation(node: node(summary(40, "旧的配对流程", ago: 9_000)), project: nil),
            ]
        )
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: nil, hostName: "mbp",
            organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: nil
        ))
    }
}
#endif
