import SwiftUI

/// A scrolling conversation that stays pinned to its end as replies grow,
/// until the reader scrolls up; scrolling back to the end pins it again.
///
/// Growth of the bottom inset (keyboard, a taller input bar) doesn't count
/// as a size change, so the end can slide out of view under it; each
/// change of `pin` jumps back to the end — bump it when the reader acts
/// at the bottom, e.g. sends or starts typing.
public struct Transcript<Content: View>: View {
    let content: Content
    let pin: Int
    @State private var position = ScrollPosition(edge: .bottom)

    public init(pin: Int = 0, @ViewBuilder content: () -> Content) {
        self.pin = pin
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
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .onChange(of: pin) {
            withAnimation { position.scrollTo(edge: .bottom) }
        }
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
