import AgentChatCore
import Foundation
import PinomadCore

/// The fields a subagent card reads from its child summary. Kept apart
/// from `ConversationSummary` so row equality ignores the fields that churn
/// on every snapshot (updatedAt, activity, and a foreground child's status).
public struct SubagentCardSummary: Sendable, Equatable {
    /// The name the card shows — the subagent's name, else the call's
    /// label or the child's task.
    public let title: String
    /// The named agent it ran as (ADR-0023), without the leading `@`.
    public let role: String?
    /// The subagent's family-unique name (ADR-0046); nil before 5.33.
    public let name: String?
    /// The child's own status, kept only for a background subagent: a
    /// background call's card follows it, while a foreground card reads its
    /// call and must not re-render on the child's churn.
    public let backgroundStatus: ConversationStatus?

    public init(title: String, role: String?, name: String? = nil,
                backgroundStatus: ConversationStatus? = nil) {
        self.title = title
        self.role = role
        self.name = name
        self.backgroundStatus = backgroundStatus
    }
}

/// A subagent call lifted out of a run's trace, plus what its child
/// conversation says about it. The role comes from the child summary
/// (SubagentDoc.role projected by the host), not from the tool detail.
public struct SubagentCard: Sendable, Equatable, Identifiable {
    public enum Status: Sendable, Equatable {
        case running
        case done
        case failed
        /// A background subagent waiting for its next message.
        case idle
    }

    /// The core's card key (step/call), stable across snapshots.
    public let key: String
    /// The child conversation a tap opens; nil until the call has recorded
    /// one, so a card that cannot navigate stays plain.
    public let conversationId: UInt64?
    public let title: String
    public let status: Status
    /// `@name` when the delegating call named an agent (ADR-0023 §4);
    /// nil for an ordinary subagent.
    public let role: String?
    public let model: String?
    /// Its own worktree's branch (`checkout: "worktree"`), to merge from.
    public let branch: String?
    public let elapsed: String?
    /// The child's recorded result, shown behind the card's disclosure.
    public let output: String?
    /// Dispatched with `background: true` and handed over: the status is
    /// the subagent's own, not the call's (ADR-0046 §1).
    public let background: Bool

    public var id: String { key }

    /// The muted line after the status, in the web card's order. The view
    /// prepends "Background" and the localized status.
    public var meta: [String] {
        [role, model, branch, elapsed].compactMap { $0 }
    }

    public init(
        key: String,
        conversationId: UInt64?,
        title: String,
        status: Status,
        role: String?,
        model: String?,
        branch: String? = nil,
        elapsed: String?,
        output: String?,
        background: Bool = false
    ) {
        self.key = key
        self.conversationId = conversationId
        self.title = title
        self.status = status
        self.role = role
        self.model = model
        self.branch = branch
        self.elapsed = elapsed
        self.output = output
        self.background = background
    }
}

extension ChatAdapter {
    /// The card facts for every subagent under `node`, forks included.
    /// Pass the family root: a fork shows the calls it inherited from its
    /// parent, whose subagents sit under the parent, not the fork.
    public static func subagentSummaries(in node: ConversationNode?) -> [UInt64: SubagentCardSummary] {
        guard let node else { return [:] }
        var summaries: [UInt64: SubagentCardSummary] = [:]
        var stack = node.children
        while let child = stack.popLast() {
            stack.append(contentsOf: child.children)
            guard child.summary.kind == .subagent, let id = child.summary.id else { continue }
            summaries[id] = SubagentCardSummary(
                title: conversationName(summary: child.summary),
                role: child.summary.role,
                name: child.summary.name,
                backgroundStatus: child.summary.lifecycle == .background ? child.summary.status : nil
            )
        }
        return summaries
    }

    /// One run split into the trace it still shows and the subagent cards
    /// lifted out of it. The cards are the web's anchors: the child
    /// summary supplies the call-given label and the role.
    public static func splitRun(
        _ cot: CotView,
        summaries: [UInt64: SubagentCardSummary]
    ) -> (trace: CotView, cards: [SubagentCard]) {
        // The FFI call copies the whole run (answer, tool output, images).
        // Most runs have no subagent; skip the crossing for them.
        guard hasSubagentCalls(cot) else { return (cot, []) }
        let split = splitSubagentCalls(view: cot)
        let cards = split.subagents.map { lifted in
            let child = conversationID(of: lifted.tool)
            return card(tool: lifted.tool, summary: child.flatMap { summaries[$0] }, key: lifted.key)
        }
        return (split.view, cards)
    }

    /// One card from a subagent call and its child summary. Without a
    /// summary (the child hasn't reached the organized tree yet) the card
    /// still names the call by its `name` or task, just without a role.
    public static func card(tool: ToolItem, summary: SubagentCardSummary?, key: String) -> SubagentCard {
        var model: String?
        var branch: String?
        var elapsed: String?
        var recorded: String?
        if case let .subagent(_, output, modelName, startedAt, endedAt, worktreeBranch)? = tool.pinomad {
            model = modelName
            branch = worktreeBranch
            recorded = output
            elapsed = elapsedText(startedAt: startedAt, endedAt: endedAt)
        }
        let args = SubagentArgs(tool.argsText)
        let title = summary?.name ?? args.name ?? summary?.title
            ?? toolTargetFromArgs(argsText: tool.argsText)
            ?? toolDisplayName(name: tool.toolName)
            ?? "Subagent"
        let callStatus = status(of: tool.state)
        // Dispatched to the background and the call went through: the work
        // is the subagent's now, and the call's end only marks the handover.
        let background = callStatus == .done && args.background
        return SubagentCard(
            key: key,
            conversationId: conversationID(of: tool),
            title: title,
            status: background ? backgroundStatus(summary?.backgroundStatus) : callStatus,
            role: summary?.role.flatMap { $0.isEmpty ? nil : "@\($0)" },
            model: model,
            branch: branch,
            elapsed: background ? nil : elapsed,
            output: tool.output ?? recorded,
            background: background
        )
    }

    private static func hasSubagentCalls(_ cot: CotView) -> Bool {
        cot.steps.contains { step in
            guard case let .tools(_, tools, _, _) = step else { return false }
            return tools.contains { $0.toolName == "subagent" }
        }
    }

    static func conversationID(of tool: ToolItem) -> UInt64? {
        guard let detail = tool.pinomad,
              case let .subagent(conversationId, _, _, _, _, _) = detail
        else { return nil }
        return conversationId
    }

    private static func status(of state: ToolPartState) -> SubagentCard.Status {
        switch state {
        case .outputAvailable: .done
        case .outputError: .failed
        default: .running
        }
    }

    /// No status means idle; a subagent cannot ask the user (ADR-0046 §8),
    /// so anything else live is work in progress.
    private static func backgroundStatus(_ status: ConversationStatus?) -> SubagentCard.Status {
        switch status {
        case nil: .idle
        case .failed?: .failed
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

/// The `subagent` call arguments the card reads. Arguments still streaming,
/// or not an object, read as neither.
private struct SubagentArgs {
    var name: String?
    var background = false

    init(_ text: String?) {
        guard let data = text?.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        if let name = object["name"] as? String, !name.isEmpty { self.name = name }
        // Only JSON `true`: a number would bridge to Bool too.
        if let flag = object["background"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() {
            background = flag.boolValue
        }
    }
}
