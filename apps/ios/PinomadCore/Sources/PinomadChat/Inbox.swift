import Foundation
import PinomadCore

// Where a conversation sits in the Inbox (ADR-0051) and how Inbox things
// read — the Web's `entities/inbox/inbox.ts`. Task states and groups come
// from the core (`inboxTaskState`, `groupInboxTasks`).

/// The project Inbox a conversation belongs to, and its task unless it is
/// the intake.
public struct InboxPlace: Equatable, Sendable {
    public let inbox: ProjectInbox
    public let task: InboxTask?
}

/// One task with its state, its group, and the state in words.
public struct InboxTaskInfo: Equatable, Sendable, Identifiable {
    public let task: InboxTask
    public let state: InboxTaskState
    public let group: InboxGroupName
    /// The state in words, with the queue position while queued.
    public let text: String

    public var id: String { task.id }
}

/// One of the four groups, in the sidebar's order, with its tasks.
public struct InboxTaskSection: Equatable, Sendable, Identifiable {
    public let group: InboxGroupName
    public let tasks: [InboxTaskInfo]

    public init(group: InboxGroupName, tasks: [InboxTaskInfo]) {
        self.group = group
        self.tasks = tasks
    }

    public var id: InboxGroupName { group }
    public var title: String { Inbox.groupLabel(group) }
}

public enum Inbox {
    /// Every conversation the Inbox owns: intakes and task (and tidy-up)
    /// conversations. They stay out of the coding lists.
    public static func conversationIds(_ inboxes: [ProjectInbox]?) -> Set<UInt64> {
        var ids = Set<UInt64>()
        for inbox in inboxes ?? [] {
            if let intake = inbox.intake { ids.insert(intake) }
            for task in inbox.tasks { if let id = task.conversationId { ids.insert(id) } }
        }
        return ids
    }

    /// The tree the coding lists show: the projects without the Inbox's
    /// conversations (ADR-0051 §2). Chats and archived roots are untouched.
    public static func codingView(_ organized: Organized, inboxes: [ProjectInbox]?) -> Organized {
        let ids = conversationIds(inboxes)
        guard !ids.isEmpty else { return organized }
        var view = organized
        view.projects = organized.projects.map { group in
            var group = group
            group.conversations = group.conversations.filter { node in
                node.summary.id.map { !ids.contains($0) } ?? true
            }
            return group
        }
        return view
    }

    public static func place(of conversationId: UInt64?, in inboxes: [ProjectInbox]?) -> InboxPlace? {
        guard let conversationId else { return nil }
        for inbox in inboxes ?? [] {
            if inbox.intake == conversationId { return InboxPlace(inbox: inbox, task: nil) }
            if let task = inbox.tasks.first(where: { $0.conversationId == conversationId }) {
                return InboxPlace(inbox: inbox, task: task)
            }
        }
        return nil
    }

    /// Every summary in the tree by id, forks and subagents included.
    public static func summaries(_ organized: Organized) -> [UInt64: ConversationSummary] {
        var all: [UInt64: ConversationSummary] = [:]
        func walk(_ node: ConversationNode) {
            if let id = node.summary.id { all[id] = node.summary }
            node.children.forEach(walk)
        }
        organized.chats.forEach(walk)
        organized.projects.forEach { $0.conversations.forEach(walk) }
        return all
    }

    /// A summary's status as the wire spells it, which the core's grouping reads.
    public static func wireStatus(_ status: ConversationStatus?) -> String? {
        switch status {
        case .needsAnswer?: "needs-answer"
        case .running?: "running"
        case .failed?: "failed"
        case .other(let raw)?: raw
        case nil: nil
        }
    }

    /// The Inbox's tasks in their groups (empty groups left out), each with
    /// its state and, while queued, its place in the worker's order.
    public static func sections(
        _ inbox: ProjectInbox, summaries: [UInt64: ConversationSummary]
    ) -> [InboxTaskSection] {
        let summaryOf = { (task: InboxTask) in task.conversationId.flatMap { summaries[$0] } }
        var statuses: [UInt64: String] = [:]
        for task in inbox.tasks {
            if let id = task.conversationId, let status = wireStatus(summaries[id]?.status) { statuses[id] = status }
        }
        return groupInboxTasks(tasks: inbox.tasks, statuses: statuses).compactMap { group in
            guard !group.tasks.isEmpty else { return nil }
            let infos = group.tasks.enumerated().map { index, task in
                let summary = summaryOf(task)
                let state = inboxTaskState(task: task, status: wireStatus(summary?.status))
                return InboxTaskInfo(
                    task: task, state: state, group: group.group,
                    text: stateText(state, task: task, activity: summary?.activity,
                                    position: group.group == .pending ? index + 1 : nil))
            }
            return InboxTaskSection(group: group.group, tasks: infos)
        }
    }

    /// Every task by id, as `sections` describes it.
    public static func describe(
        _ inbox: ProjectInbox, summaries: [UInt64: ConversationSummary]
    ) -> [String: InboxTaskInfo] {
        var byId: [String: InboxTaskInfo] = [:]
        for section in sections(inbox, summaries: summaries) {
            for info in section.tasks { byId[info.task.id] = info }
        }
        return byId
    }

    public static func groupLabel(_ group: InboxGroupName) -> String {
        switch group {
        case .waiting: "Waiting for you"
        case .running: "In progress"
        case .pending: "Queued"
        case .done: "Done"
        }
    }

    /// Where an event came from, in words.
    public static func sourceLabel(_ source: String) -> String {
        switch source {
        case "user": "From you"
        case "schedule": "Scheduled"
        case "followUp": "Follow-up"
        case "webhook": "Webhook"
        default: source.hasPrefix("plugin:") ? String(source.dropFirst("plugin:".count)) : source
        }
    }

    /// What started a task: its first event's source, or the tidy-up.
    public static func taskOrigin(_ task: InboxTask) -> String {
        if task.kind == "tidy" { return "Memory tidy-up" }
        return task.events.first.map { sourceLabel($0.source) } ?? "Inbox"
    }

    /// A task's state in words; `position` is its place in the queue
    /// (1-based) while queued.
    public static func stateText(
        _ state: InboxTaskState, task: InboxTask, activity: SummaryActivity? = nil, position: Int? = nil
    ) -> String {
        switch state {
        case .waiting: return "Needs your answer"
        case .running:
            guard let activity else { return "Working" }
            let tool = toolDisplayName(name: activity.tool) ?? activity.tool
            return "Working · \(tool)" + (activity.target.map { " \($0)" } ?? "")
        case .pending: return position.map { "#\($0) in queue" } ?? "Queued"
        case .skipped: return "Skipped"
        case .failed: return "Failed: \(task.failed ?? "unknown error")"
        case .done: return "Done"
        }
    }

    /// The events a batch delivered that the Inbox still lists, in delivery order.
    public static func batchEvents(_ eventIds: [String], task: InboxTask?) -> [InboxEvent] {
        guard let task else { return [] }
        let byId = Dictionary(task.events.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return eventIds.compactMap { byId[$0] }
    }
}

/// One task an intake's `inbox_submit` call filed, as its card shows it.
public struct InboxFiledCard: Equatable, Sendable, Identifiable {
    public let id: String
    /// The filed task, while the Inbox still lists it; the card opens it.
    public let task: InboxTask?
    public let state: InboxTaskState?
    public let title: String
    public let detail: String

    /// The cards for a run's `inbox_submit` calls, in call order. A call's
    /// arguments are the model's and may be malformed: each field counts
    /// only when it is a string, and the title falls back to "Task".
    public static func of(_ cot: CotView, tasks: [String: InboxTaskInfo]) -> [InboxFiledCard] {
        var cards: [InboxFiledCard] = []
        for step in cot.steps {
            guard case let .tools(stepId, tools, _, _) = step else { continue }
            for (index, tool) in tools.enumerated() where tool.toolName == "inbox_submit" {
                let args = arguments(tool.argsText)
                var filed: (task: String, title: String, merged: Bool)?
                if case let .inboxSubmit(task, title, merged)? = tool.pinomad { filed = (task, title, merged) }
                let info = filed.flatMap { tasks[$0.task] }
                let title = [info?.task.title, filed?.title, args.title]
                    .compactMap { $0 }.first { !$0.isEmpty } ?? "Task"
                let what = (filed?.merged ?? (args.mergeInto != nil)) ? "Added to task" : "New task"
                let detail: String
                if tool.state == .outputError {
                    detail = "Not filed"
                } else if let info {
                    detail = "\(what) · \(info.text)"
                } else {
                    detail = filed == nil ? "Filing…" : what
                }
                cards.append(InboxFiledCard(
                    id: tool.toolCallId ?? "\(stepId).\(index)",
                    task: info?.task, state: info?.state, title: title, detail: detail))
            }
        }
        return cards
    }

    static func arguments(_ text: String?) -> (title: String?, mergeInto: String?) {
        guard let data = text?.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return (nil, nil) }
        return (object["title"] as? String, object["mergeInto"] as? String)
    }
}
