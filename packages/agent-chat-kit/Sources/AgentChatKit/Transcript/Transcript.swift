import SwiftUI

/// A scrolling conversation that stays pinned to its end as replies grow,
/// until the reader scrolls up; scrolling back to the end pins it again.
public struct Transcript<Content: View>: View {
    let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
    }
}

/// What the user sent, set apart from the agent's side of the conversation.
public struct UserMessageView: View {
    let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        Text(text)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.fill.tertiary, in: .rect(cornerRadius: 18))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 48)
            .textSelection(.enabled)
    }
}
