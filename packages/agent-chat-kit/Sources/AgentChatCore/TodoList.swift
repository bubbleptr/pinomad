import Foundation

/// The plan an agent keeps for a conversation: one list, rewritten whole
/// each time the agent updates it.
public struct TodoList: Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        case pending
        case inProgress
        case completed
    }

    public struct Item: Sendable, Equatable {
        public var text: String
        public var status: Status

        public init(text: String, status: Status) {
            self.text = text
            self.status = status
        }
    }

    public var items: [Item]

    public init(items: [Item]) {
        self.items = items
    }

    public var completedCount: Int {
        items.count { $0.status == .completed }
    }

    public var isFinished: Bool {
        !items.isEmpty && completedCount == items.count
    }

    /// What the agent is on: the item it marked in progress, else the next
    /// one waiting.
    public var current: Item? {
        items.first { $0.status == .inProgress } ?? items.first { $0.status == .pending }
    }
}

/// The todo list as a line under a run's capsule. It follows the newest run
/// only, and only while it means something there: the run wrote the list,
/// or the list still has work left. A finished list the next run never
/// touched has nothing left to say.
public struct TodoLine: Sendable, Equatable {
    public var list: TodoList
    /// When the run last wrote the list; the list may be stale, and this is
    /// how stale.
    public var writtenAt: Date?

    public init?(list: TodoList?, writtenAt: Date?, isLatestRun: Bool) {
        guard isLatestRun, let list, !list.items.isEmpty,
              writtenAt != nil || !list.isFinished
        else { return nil }
        self.list = list
        self.writtenAt = writtenAt
    }
}
