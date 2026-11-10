import AgentChatCore
import Foundation
import PinomadCore

/// What iOS calls a conversation wherever it names one. A subagent goes by
/// its family-unique name (ADR-0046 §1) — the one its dispatcher's reports
/// and the subagent tools use — and falls back to the shared display name
/// on hosts from before names.
public func conversationName(summary: ConversationSummary) -> String {
    if summary.kind == .subagent, let name = summary.name, !name.isEmpty { return name }
    return displayName(summary: summary)
}

/// Whether the user can talk to a subagent (ADR-0046 §6), the Web's
/// `subagentMessaging`.
public enum SubagentMessaging: Equatable, Sendable {
    /// A host without `subagentStop`, or a subagent from before names,
    /// which the host refuses messages for.
    case readOnly
    /// A foreground subagent still answering the call that dispatched it:
    /// the host refuses messages until the call ends, but Stop works (the
    /// call then fails, like Esc in the parent).
    case inCall
    /// Messages and Stop.
    case open

    public init(summary: ConversationSummary, hostMinor: UInt32) {
        guard hostSupportsFeature(hostMinor: hostMinor, feature: .subagentStop),
              summary.name != nil
        else {
            self = .readOnly
            return
        }
        // Running outside its call turns a subagent background in the same
        // commit, so a running foreground one is necessarily inside it.
        self = summary.lifecycle != .background && summary.status == .running ? .inCall : .open
    }
}

/// What the dispatching `subagent` call recorded about its child: the
/// model it ran on and, for `checkout: "worktree"`, its branch.
public struct SubagentCallFacts: Equatable, Sendable {
    public let model: String?
    public let branch: String?

    public init(model: String?, branch: String?) {
        self.model = model
        self.branch = branch
    }
}

/// One background subagent in the strip above the composer.
public struct BackgroundSubagent: Equatable, Sendable, Identifiable {
    public let id: UInt64
    /// Its name, or the display name on a host from before names.
    public let name: String
    /// The call's label (or task) when it says more than the name.
    public let label: String?
    public let model: String?
    /// Its own worktree's branch, known when the shown conversation holds
    /// the call that dispatched it.
    public let branch: String?
    /// Working on a message right now: Stop applies.
    public let working: Bool
    public let failed: Bool

    public init(id: UInt64, name: String, label: String?, model: String?, branch: String?,
                working: Bool, failed: Bool) {
        self.id = id
        self.name = name
        self.label = label
        self.model = model
        self.branch = branch
        self.working = working
        self.failed = failed
    }
}

public enum BackgroundSubagents {
    /// The family's background subagents for the conversation shown: none
    /// while a subagent itself is shown (it cannot dispatch, ADR-0046 §8).
    /// Working ones first in the order they were dispatched, so cycling
    /// through them does not jump as they report activity; then the rest,
    /// most recently active first.
    /// `calls` is read only when there is something to show: scanning a
    /// transcript on every streaming snapshot buys nothing for the
    /// conversations without background subagents.
    public static func of(
        shown: ConversationNode,
        organized: Organized,
        calls: @autoclosure () -> [UInt64: SubagentCallFacts],
        models: [ModelSummary]
    ) -> [BackgroundSubagent] {
        guard shown.summary.kind != .subagent else { return [] }
        // A top-level conversation is its own root: skip copying the tree
        // across the FFI again to find it.
        let root = shown.summary.parent == nil
            ? shown : shown.summary.id.flatMap { rootOf(organized: organized, id: $0) }
        guard let root else { return [] }
        let summaries = ordered(backgroundSubagentsOf(root: root).map(\.summary))
        guard !summaries.isEmpty else { return [] }
        let calls = calls()
        return summaries.compactMap { summary in
            guard let id = summary.id else { return nil }
            let name = conversationName(summary: summary)
            let label = summary.label ?? displayName(summary: summary)
            let call = calls[id]
            return BackgroundSubagent(
                id: id,
                name: name,
                label: label.isEmpty || label == name ? nil : label,
                model: summary.model.map { modelName($0, models: models) } ?? call?.model,
                branch: call?.branch,
                working: summary.status == .running,
                failed: summary.status == .failed
            )
        }
    }

    static func ordered(_ summaries: [ConversationSummary]) -> [ConversationSummary] {
        let working = summaries.filter { $0.status == .running }
            .sorted { ($0.id ?? 0) < ($1.id ?? 0) }
        let rest = summaries.filter { $0.status != .running }
            .sorted { lhs, rhs in
                let l = lhs.updatedAt ?? 0, r = rhs.updatedAt ?? 0
                return l != r ? l > r : (lhs.id ?? 0) > (rhs.id ?? 0)
            }
        return working + rest
    }

    /// The listed model's name, else its id.
    private static func modelName(_ ref: ModelRef, models: [ModelSummary]) -> String {
        models.first { sameModel(a: ModelRef(provider: $0.provider, modelId: $0.modelId), b: ref) }?.name
            ?? ref.modelId
    }
}

/// Which background subagent the strip shows. Kept by id so a reorder
/// never swaps it for another; when it leaves the list the strip stays at
/// the same position, clamped to the end.
public struct BackgroundSelection: Equatable, Sendable {
    public private(set) var id: UInt64?
    private var index: Int

    public init() {
        id = nil
        index = 0
    }

    /// The shown item's position, or nil for an empty list.
    public func index(in items: [BackgroundSubagent]) -> Int? {
        guard !items.isEmpty else { return nil }
        if let id, let found = items.firstIndex(where: { $0.id == id }) { return found }
        return min(index, items.count - 1)
    }

    /// Pin the resolved item, so a later removal clamps from where it is now.
    public mutating func sync(_ items: [BackgroundSubagent]) {
        guard let at = index(in: items) else {
            id = nil
            index = 0
            return
        }
        id = items[at].id
        index = at
    }

    /// The next one, wrapping to the first.
    public mutating func next(_ items: [BackgroundSubagent]) {
        guard let at = index(in: items) else { return }
        let following = (at + 1) % items.count
        id = items[following].id
        index = following
    }
}

extension ChatAdapter {
    /// The facts each `subagent` call in a transcript recorded, by child.
    /// A later call for the same child (a rerun) wins.
    public static func subagentCalls(in chat: [ChatEntry]) -> [UInt64: SubagentCallFacts] {
        var facts: [UInt64: SubagentCallFacts] = [:]
        for entry in chat {
            guard case let .run(_, cot, _, _, _, _) = entry else { continue }
            for step in cot.steps {
                guard case let .tools(_, tools, _, _) = step else { continue }
                for tool in tools where tool.toolName == "subagent" {
                    guard case let .subagent(child, _, model, _, _, branch)? = tool.pinomad else { continue }
                    facts[child] = SubagentCallFacts(model: model, branch: branch)
                }
            }
        }
        return facts
    }
}
