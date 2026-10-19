import AgentChatCore
import Foundation
import PinomadCore

/// A subagent call lifted out of a run's trace, plus what its child
/// conversation says about it. The role comes from the child summary
/// (SubagentDoc.role projected by the host), not from the tool detail.
public struct SubagentCard: Sendable, Equatable, Identifiable {
    public enum Status: Sendable, Equatable {
        case running
        case done
        case failed
    }

    /// The core's card key (step/call), stable across snapshots.
    public let key: String
    public let title: String
    public let status: Status
    /// `@name` when the delegating call named an agent (ADR-0023 §4);
    /// nil for an ordinary subagent.
    public let role: String?
    public let model: String?
    public let elapsed: String?
    /// The child's recorded result, shown behind the card's disclosure.
    public let output: String?

    public var id: String { key }

    /// The muted line after the status, in the web card's order. The view
    /// prepends the localized status.
    public var meta: [String] {
        [role, model, elapsed].compactMap { $0 }
    }

    public init(
        key: String,
        title: String,
        status: Status,
        role: String?,
        model: String?,
        elapsed: String?,
        output: String?
    ) {
        self.key = key
        self.title = title
        self.status = status
        self.role = role
        self.model = model
        self.elapsed = elapsed
        self.output = output
    }
}

extension ChatAdapter {
    /// One run split into the trace it still shows and the subagent cards
    /// lifted out of it. The cards are the web's anchors: the child
    /// summary supplies the call-given label and the role.
    public static func splitRun(_ cot: CotView, organized: Organized?) -> (trace: CotView, cards: [SubagentCard]) {
        // The FFI call copies the whole run (answer, tool output, images).
        // Most runs have no subagent; skip the crossing for them.
        guard hasSubagentCalls(cot) else { return (cot, []) }
        let split = splitSubagentCalls(view: cot)
        let summaries = summariesByID(organized)
        let cards = split.subagents.map { lifted in
            card(tool: lifted.tool, summary: conversationID(of: lifted.tool).flatMap { summaries[$0] }, key: lifted.key)
        }
        return (split.view, cards)
    }

    /// One card from a subagent call and its child summary. Without a
    /// summary (the child hasn't reached the organized tree yet) the card
    /// still names the call by its task, just without a role.
    public static func card(tool: ToolItem, summary: ConversationSummary?, key: String) -> SubagentCard {
        var model: String?
        var elapsed: String?
        var recorded: String?
        if case let .subagent(_, output, modelName, startedAt, endedAt)? = tool.pinomad {
            model = modelName
            recorded = output
            elapsed = elapsedText(startedAt: startedAt, endedAt: endedAt)
        }
        let title: String
        if let summary {
            title = displayName(summary: summary)
        } else {
            title = toolTargetFromArgs(argsText: tool.argsText)
                ?? toolDisplayName(name: tool.toolName)
                ?? "Subagent"
        }
        return SubagentCard(
            key: key,
            // A summary with neither label nor task falls back to the core's
            // English "Subagent"; the interface is Chinese.
            title: title == "Subagent" ? "子代理" : title,
            status: status(of: tool.state),
            role: summary?.role.flatMap { $0.isEmpty ? nil : "@\($0)" },
            model: model,
            elapsed: elapsed,
            output: tool.output ?? recorded
        )
    }

    private static func hasSubagentCalls(_ cot: CotView) -> Bool {
        cot.steps.contains { step in
            guard case let .tools(_, tools, _, _) = step else { return false }
            return tools.contains { $0.toolName == "subagent" }
        }
    }

    private static func conversationID(of tool: ToolItem) -> UInt64? {
        guard let detail = tool.pinomad,
              case let .subagent(conversationId, _, _, _, _) = detail
        else { return nil }
        return conversationId
    }

    /// The organized tree flattened to id → summary. Looking up through the
    /// core would copy the whole tree across FFI once per card; this walk
    /// stays on the Swift side and is cheap.
    private static func summariesByID(_ organized: Organized?) -> [UInt64: ConversationSummary] {
        guard let organized else { return [:] }
        var summaries: [UInt64: ConversationSummary] = [:]
        func walk(_ node: ConversationNode) {
            if let id = node.summary.id { summaries[id] = node.summary }
            node.children.forEach(walk)
        }
        organized.chats.forEach(walk)
        organized.projects.forEach { $0.conversations.forEach(walk) }
        organized.archived.forEach { walk($0.node) }
        return summaries
    }

    private static func status(of state: ToolPartState) -> SubagentCard.Status {
        switch state {
        case .outputAvailable: .done
        case .outputError: .failed
        default: .running
        }
    }

    /// The web card's duration: "12s" under a minute, else "1m 5s".
    private static func elapsedText(startedAt: Double?, endedAt: Double?) -> String? {
        guard let startedAt, let endedAt, endedAt >= startedAt else { return nil }
        let seconds = Int(((endedAt - startedAt) / 1000).rounded(.down))
        if seconds < 60 { return "\(seconds)s" }
        return "\(seconds / 60)m \(seconds % 60)s"
    }
}
