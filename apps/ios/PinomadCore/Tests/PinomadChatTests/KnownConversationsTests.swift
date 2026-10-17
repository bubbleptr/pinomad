import Testing
@testable import PinomadChat
import PinomadCore

private func node(_ id: UInt64, children: [ConversationNode] = []) -> ConversationNode {
    ConversationNode(
        summary: ConversationSummary(
            id: id, kind: nil, parent: nil, forkedAt: nil, title: nil, status: nil,
            updatedAt: nil, label: nil, role: nil, activity: nil),
        children: children)
}

@Suite struct KnownConversationsTests {
    private let organized = Organized(
        chats: [node(1, children: [node(2)])],
        projects: [ProjectConversations(project: Project(path: "/p", name: "p", addedAt: nil), conversations: [node(3)])],
        archived: [ArchivedConversation(node: node(4), project: nil)])

    @Test func everyListedConversationIsKnown() {
        #expect(KnownConversations(organized).ids == [1, 2, 3, 4])
    }

    /// A create resolves before its snapshot lands, and an earlier queued
    /// switch can publish meanwhile — an already-known conversation coming
    /// into view is that switch, not the conversation just created.
    @Test func onlyAnUnknownShownConversationIsTheCreatedOne() {
        let known = KnownConversations(organized)
        #expect(known.created(shown: 2) == nil)
        #expect(known.created(shown: nil) == nil)
        #expect(known.created(shown: 9) == 9)
    }
}
