import Foundation
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
            let name = conversationName(summary: task)
            return Row(
                id: id,
                name: name,
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

/// The overview's background-process section (ADR-0045): the family root's
/// list, live rows before ended ones, with Stop only while the host still
/// has the process. The core already ordered and worded the rows; this maps
/// them to display values and folds overflow like Subagents.
public struct ProcessesOverview: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        /// The command when it says more than the name.
        public let command: String?
        /// The long state line, including the old pid for `lost`.
        public let status: String
        /// The short right-hand result: `exit 1`, `Stopped`, `Lost`.
        public let result: String
        public let state: ProcessState
        public let active: Bool
        public let canStop: Bool
        public let startedAt: Date
    }

    public let rows: [Row]
    /// Live processes past the listed ones.
    public let moreRunning: Int
    /// Ended processes past the listed ones.
    public let moreEnded: Int
    /// Whether the host has `hello.processes`, so Stop is meaningful at all.
    public let canStop: Bool
    /// Why Stop is gone (old host or no pty module), for the section's note.
    public let unavailable: String?

    /// Live and ended rows each show this many before folding into counts.
    public static let listed = 3
    public static let footer = "Background processes stop when the host restarts."

    public init(view: ProcessesView) {
        let live = view.processes.filter(\.active)
        let ended = view.processes.filter { !$0.active }
        let row = { (process: BackgroundProcess) in
            Row(
                id: process.id,
                name: process.name,
                command: process.command == process.name ? nil : process.command,
                status: process.status,
                result: process.result,
                state: process.state,
                active: process.active,
                canStop: view.stopAvailable && process.active,
                startedAt: Date(timeIntervalSince1970: process.startedAt / 1000)
            )
        }
        rows = live.prefix(Self.listed).map(row) + ended.prefix(Self.listed).map(row)
        moreRunning = max(0, live.count - Self.listed)
        moreEnded = max(0, ended.count - Self.listed)
        canStop = view.stopAvailable
        unavailable = view.unavailable
    }

    /// The family's list for `conversation`, or nil when it has none (the
    /// section hides). A fork reads its root's watched list, never another
    /// family's.
    public static func of(
        organized: Organized, conversation: UInt64, processes: ProcessesView?
    ) -> ProcessesOverview? {
        guard let root = rootOf(organized: organized, id: conversation)?.summary.id,
              let processes, processes.root == root, !processes.processes.isEmpty
        else { return nil }
        return ProcessesOverview(view: processes)
    }
}

/// `12s` under a minute, otherwise `1m 5s` — the same clock as the Web list.
public func processElapsedText(ms: Double) -> String {
    // A host can send any number as startedAt; converting a non-finite or
    // out-of-range Double to Int traps. Hide the duration instead.
    guard ms.isFinite else { return "" }
    let seconds = ms / 1000
    guard seconds >= Double(Int.min), seconds <= Double(Int.max) else { return "" }
    let whole = max(0, Int(seconds))
    if whole < 60 { return "\(whole)s" }
    return "\(whole / 60)m \(whole % 60)s"
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
            guard case let .run(id, cot, _, _, _, _) = entry else { continue }
            let spawns = cot.steps.contains { step in
                guard case let .tools(_, tools, _, _) = step else { return false }
                return tools.contains { conversationID(of: $0) == child }
            }
            if spawns { return id }
        }
        return nil
    }
}
