import PinomadCore

/// The overview sheet's subagent section (the Web card's Subagents): the
/// whole family's tasks, the running ones listed by name up to a limit and
/// everything else folded into counts.
public struct SubagentOverview: Equatable, Sendable {
    /// A running task, or one waiting for the user's answer.
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: UInt64
        public let name: String
        public let waiting: Bool
        /// The tool it is using right now, by display name.
        public let activity: String?
    }

    public let active: [Row]
    /// Running tasks past the listed ones.
    public let moreRunning: Int
    /// Tasks neither running nor failed — the Web card's "done".
    public let finished: Int
    public let failed: Int

    /// Running subagents listed by name before the rest fold into counts.
    public static let listed = 3

    public init(tasks: [ConversationSummary]) {
        let active = tasks.filter { $0.status == .running || $0.status == .needsAnswer }
        let failed = tasks.filter { $0.status == .failed }.count
        self.active = active.prefix(Self.listed).compactMap { task in
            guard let id = task.id else { return nil }
            let name = displayName(summary: task)
            return Row(
                id: id,
                // The core's fallback name is English; the interface is Chinese.
                name: name == "Subagent" ? "子代理" : name,
                waiting: task.status == .needsAnswer,
                activity: task.activity.map { toolDisplayName(name: $0.tool) ?? $0.tool }
            )
        }
        moreRunning = max(0, active.count - Self.listed)
        finished = tasks.count - active.count - failed
        self.failed = failed
    }

    /// The overview for the family `conversation` belongs to, or nil when
    /// it has no subagents (the section hides).
    public static func of(organized: Organized, conversation: UInt64) -> SubagentOverview? {
        guard let root = rootOf(organized: organized, id: conversation) else { return nil }
        let tasks = taskGroupsOf(root: root).flatMap { $0.tasks.map(\.summary) }
        return tasks.isEmpty ? nil : SubagentOverview(tasks: tasks)
    }
}

/// The branch the workspace is on. A host that reports the live branch
/// with `changes()` (5.11) is authoritative once it answered — a detached
/// HEAD shows none even if the worktree record names one. Before that
/// answer, and on older hosts, the worktree record stands in.
public func workspaceBranch(
    hostMinor: UInt32?,
    changes: ConversationChanges?,
    checkout: WorktreeCheckout?
) -> String? {
    if let hostMinor, let changes, hostSupportsFeature(hostMinor: hostMinor, feature: .liveBranch) {
        switch changes {
        case .available(_, _, _, let branch), .unavailable(_, let branch):
            return branch
        }
    }
    return checkout?.branch
}

extension ChatAdapter {
    /// The run whose subagent call delegated `child` — where the reader
    /// returns to after opening the child from outside its card.
    public static func runSpawning(_ child: UInt64, in chat: [ChatEntry]) -> String? {
        for entry in chat.reversed() {
            guard case let .run(id, cot, _, _, _) = entry else { continue }
            let spawns = cot.steps.contains { step in
                guard case let .tools(_, tools, _, _) = step else { return false }
                return tools.contains { conversationID(of: $0) == child }
            }
            if spawns { return id }
        }
        return nil
    }
}
