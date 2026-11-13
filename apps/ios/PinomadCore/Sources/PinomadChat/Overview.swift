import Foundation
import PinomadCore

/// Where a task stands, the color of its icon: at work (running or waiting
/// for an answer), failed, or over.
public enum TaskTone: Equatable, Sendable {
    case running, failed, done
}

/// The overview sheet's subagent section. iOS has no Tasks panel, so the
/// sheet lists the family's every subagent: the ones at work in the
/// family's order, then failed, then finished, each newest first. The view
/// shows the first `listed` and folds the rest behind "Show all".
public struct SubagentOverview: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: UInt64
        public let name: String
        public let tone: TaskTone
        /// Where it stands in words: "Running · bash bun test", "Waiting
        /// for an answer", "Failed", "Done".
        public let state: String
        public let updatedAt: Date?
    }

    public let rows: [Row]

    /// Rows shown before "Show all" — at least every subagent at work.
    public var listed: Int { max(Self.minimumListed, rows.prefix { $0.tone == .running }.count) }

    public static let minimumListed = 3

    public init(tasks: [ConversationSummary]) {
        let rank: (TaskTone) -> Int = { tone in
            switch tone {
            case .running: 0
            case .failed: 1
            case .done: 2
            }
        }
        let rows = tasks.compactMap { task -> Row? in
            guard let id = task.id else { return nil }
            let tone = subagentTone(task.status)
            return Row(
                id: id,
                name: conversationName(summary: task),
                tone: tone,
                state: subagentStateText(task),
                updatedAt: task.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
            )
        }
        // A stable sort: rows at work keep the family's order.
        self.rows = rows.enumerated().sorted { a, b in
            let (ra, rb) = (rank(a.element.tone), rank(b.element.tone))
            if ra != rb { return ra < rb }
            if a.element.tone != .running {
                let (ta, tb) = (a.element.updatedAt ?? .distantPast, b.element.updatedAt ?? .distantPast)
                if ta != tb { return ta > tb }
            }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// The overview for the family `conversation` belongs to, or nil when
    /// it has no subagents (the section hides).
    public static func of(organized: Organized, conversation: UInt64) -> SubagentOverview? {
        guard let root = rootOf(organized: organized, id: conversation) else { return nil }
        let tasks = taskGroupsOf(root: root).flatMap { $0.tasks.map(\.summary) }
        return tasks.isEmpty ? nil : SubagentOverview(tasks: tasks)
    }
}

/// A subagent's tone; one with no status (or one this client doesn't know)
/// has finished.
public func subagentTone(_ status: ConversationStatus?) -> TaskTone {
    switch status {
    case .running?, .needsAnswer?: .running
    case .failed?: .failed
    default: .done
    }
}

private func subagentStateText(_ task: ConversationSummary) -> String {
    switch task.status {
    case .needsAnswer?: return "Waiting for an answer"
    case .failed?: return "Failed"
    case .running?:
        guard let activity = task.activity else { return "Running" }
        let tool = toolDisplayName(name: activity.tool) ?? activity.tool
        return "Running · \(tool)\(activity.target.map { " \($0)" } ?? "")"
    default: return "Done"
    }
}

/// A clean exit or a stop is over; a non-zero exit, a signal, a failed
/// start or a lost pty failed.
public func processTone(_ state: ProcessState) -> TaskTone {
    switch state {
    case .starting, .running: .running
    case .lost, .failed: .failed
    case let .exited(code, signal): signal == nil && code == 0 ? .done : .failed
    case .stopped: .done
    }
}

/// A few words for a process row: "Running", "Exited 1", "Stopped", "Lost track".
public func processShortText(_ state: ProcessState) -> String {
    switch state {
    case .starting: "Starting"
    case .running: "Running"
    case .lost: "Lost track"
    case .failed: "Failed to start"
    case .stopped: "Stopped"
    case let .exited(code, signal):
        if let signal { "Exited (\(signal))" } else if let code { "Exited \(code)" } else { "Exited" }
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
        public let processState: ProcessState
        public let tone: TaskTone
        /// Where it stands in a few words: "Running", "Exited 1", "Lost track".
        public let state: String
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
                processState: process.state,
                tone: processTone(process.state),
                state: processShortText(process.state),
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

/// The path under the workspace folder's name. The name already says which
/// folder, so the path stops at its parent — a project's, even when the
/// conversation runs in its worktree. A chat's folder is shown as "Chat
/// folder", not by its own name, so it keeps the full path.
public func workspaceFolderPath(cwd: String, home: Home?) -> String {
    switch home {
    case .project(let path): return parentFolder(path)
    case .chat: return cwd
    default: return parentFolder(cwd)
    }
}

private func parentFolder(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
    return String(path[..<slash])
}

/// Whether the checkout has anything to open. A clean one, one with no
/// repository, and one not answered yet show no Changes row.
public func workspaceHasChanges(_ changes: ConversationChanges?) -> Bool {
    if case .available(_, let files, _, _)? = changes { return !files.isEmpty }
    return false
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
