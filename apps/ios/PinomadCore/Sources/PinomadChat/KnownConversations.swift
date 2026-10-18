import PinomadCore

/// Every conversation the host had listed when a create was sent — chats,
/// projects, archived, and all their forks and subagents. The create call
/// resolves before its snapshot lands, and a switch queued ahead of it can
/// publish meanwhile; only a conversation outside this set coming into view
/// is the one just created.
public struct KnownConversations: Sendable {
    public let ids: Set<UInt64>

    public init(_ organized: Organized) {
        var ids = Set<UInt64>()
        func walk(_ node: ConversationNode) {
            if let id = node.summary.id { ids.insert(id) }
            node.children.forEach(walk)
        }
        organized.chats.forEach(walk)
        organized.projects.forEach { $0.conversations.forEach(walk) }
        organized.archived.forEach { walk($0.node) }
        self.ids = ids
    }

    /// The shown conversation, if it is a new one.
    public func created(shown: UInt64?) -> UInt64? {
        guard let shown, !ids.contains(shown) else { return nil }
        return shown
    }
}
