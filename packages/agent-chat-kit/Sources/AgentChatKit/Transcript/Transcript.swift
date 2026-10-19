import SwiftUI

private final class ScrollState {
    /// The item to reveal once the first layout after mounting is ready.
    var pendingItem: String?
    var atBottom = true
    var reportedBottom = true

    init(pendingItem: String? = nil) {
        self.pendingItem = pendingItem
    }
}

/// A scrolling conversation that stays pinned to its end as replies grow,
/// until the reader scrolls up; scrolling back to the end pins it again.
///
/// Growth of the bottom inset (keyboard, a taller input bar) doesn't count
/// as a size change, so the end can slide out of view under it; each
/// change of `pin` jumps back to the end — bump it when the reader acts
/// at the bottom, e.g. sends or starts typing.
///
/// `onBottomChange` reports whether the reader is at the end. Pass a
/// `restoreItemID` when the view remounts (a pushed page returning) to
/// reveal that row once; a reader who left at the end stays at the end
/// instead.
public struct Transcript<Content: View>: View {
    let content: Content
    let pin: Int
    let restoreItemID: String?
    let onBottomChange: ((Bool) -> Void)?
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var scroll = ScrollState()

    public init(
        pin: Int = 0,
        restoreItemID: String? = nil,
        onBottomChange: ((Bool) -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.pin = pin
        self.restoreItemID = restoreItemID
        self.onBottomChange = onBottomChange
        self.content = content()
        _scroll = State(initialValue: ScrollState(pendingItem: restoreItemID))
    }

    public var body: some View {
        ScrollViewReader { proxy in
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
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 1
            } action: { _, atBottom in
                scroll.atBottom = atBottom
                if let pending = scroll.pendingItem {
                    scroll.pendingItem = nil
                    proxy.scrollTo(pending, anchor: .top)
                    // The restored position is a reader position: don't let
                    // the bottom anchor claim it when content changes.
                    position.isPositionedByUser = true
                    // The pre-restore layout reported the old end; replacing
                    // it here keeps the next card push from saving "at end".
                    scroll.atBottom = false
                    reportBottom()
                    return
                }
                reportBottom()
            }
            .onChange(of: pin) {
                withAnimation { position.scrollTo(edge: .bottom) }
            }
        }
    }

    private func reportBottom() {
        guard scroll.atBottom != scroll.reportedBottom else { return }
        scroll.reportedBottom = scroll.atBottom
        onBottomChange?(scroll.atBottom)
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
