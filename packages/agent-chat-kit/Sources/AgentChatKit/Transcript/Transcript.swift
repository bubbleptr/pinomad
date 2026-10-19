import SwiftUI

/// A scrolling conversation that stays pinned to its end as replies grow,
/// until the reader scrolls up; scrolling back to the end pins it again.
///
/// Growth of the bottom inset (keyboard, a taller input bar) doesn't count
/// as a size change, so the end can slide out of view under it; each
/// change of `pin` jumps back to the end — bump it when the reader acts
/// at the bottom, e.g. sends or starts typing.
private final class ScrollOffset {
    var value: CGPoint?
    /// Set when the transcript goes away with the reader scrolled; the next
    /// geometry report is the first layout that can accept it.
    var pending: CGPoint?
}

public struct Transcript<Content: View>: View {
    let content: Content
    let pin: Int
    @State private var position = ScrollPosition(edge: .bottom)
    /// Kept in a reference box: writes on every scroll must not invalidate
    /// the view. A disappeared transcript (a pushed page) restores it on
    /// the way back instead of letting the bottom anchor take over.
    @State private var savedOffset = ScrollOffset()

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
        .onScrollGeometryChange(for: CGPoint.self) { geometry in
            geometry.contentOffset
        } action: { _, offset in
            if let pending = savedOffset.pending {
                savedOffset.pending = nil
                position.scrollTo(point: pending)
                return
            }
            savedOffset.value = offset
        }
        .onChange(of: pin) {
            withAnimation { position.scrollTo(edge: .bottom) }
        }
        .onDisappear {
            if position.isPositionedByUser {
                savedOffset.pending = savedOffset.value
            }
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
