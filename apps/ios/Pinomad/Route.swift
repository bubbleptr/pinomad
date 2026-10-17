/// Where the navigation stack can go.
enum Route: Hashable {
    case conversation(UInt64)
    /// The draft page that creates a conversation on send.
    case newConversation
    /// The host folder picker, pushed from the draft page.
    case addProject
}
