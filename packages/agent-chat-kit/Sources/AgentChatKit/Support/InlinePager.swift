import SwiftUI

/// A one-line viewport whose pages flip vertically — the old one rises out,
/// the new one enters from below. For step labels that change while a step
/// is live: the running call's name, a batch turning into its summary. Each
/// page dwells at least `dwell` before the next may replace it; pages that
/// arrive during the wait are dropped rather than queued.
///
/// `id` says which page a value is. A new value with the shown page's id
/// updates that page in place — a streaming line grows — without a flip
/// and without restarting its dwell.
struct InlinePager<Page: Equatable, ID: Hashable, Content: View>: View {
    let page: Page
    let id: (Page) -> ID
    var dwell: Duration = .milliseconds(700)
    @ViewBuilder var content: (Page) -> Content

    @State private var shown: Page
    @State private var latest: Page
    @State private var shownAt = Date.now
    @State private var flip: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        page: Page,
        id: @escaping (Page) -> ID,
        dwell: Duration = .milliseconds(700),
        @ViewBuilder content: @escaping (Page) -> Content
    ) {
        self.page = page
        self.id = id
        self.dwell = dwell
        self.content = content
        _shown = State(initialValue: page)
        _latest = State(initialValue: page)
    }

    var body: some View {
        ZStack(alignment: .leading) {
            content(shown)
                .id(id(shown))
                .transition(.push(from: .bottom))
        }
        .clipped()
        .onChange(of: page) { _, newPage in
            latest = newPage
            if id(newPage) == id(shown) {
                updateInPlace(newPage)
                return
            }
            // A scheduled flip picks up whatever is latest when it fires.
            guard flip == nil else { return }
            let wait = dwellInterval - Date.now.timeIntervalSince(shownAt)
            flip = Task {
                if wait > 0 { try? await Task.sleep(for: .milliseconds(Int(wait * 1000))) }
                guard !Task.isCancelled else { return }
                flip = nil
                // The page may have come back to the shown one meanwhile.
                if id(latest) == id(shown) {
                    updateInPlace(latest)
                    return
                }
                shownAt = .now
                if reduceMotion {
                    shown = latest
                } else {
                    withAnimation(.easeInOut(duration: 0.25)) { shown = latest }
                }
            }
        }
        .onAppear {
            // Reappearing after a disappearance must not keep a stale page
            // — pages turned while away are not replayed.
            latest = page
            if id(shown) != id(page) { shownAt = .now }
            shown = page
        }
        .onDisappear {
            // A cancelled task returns early and would leave `flip` set,
            // blocking every page change after the view comes back.
            flip?.cancel()
            flip = nil
        }
    }

    /// The same page with new content. A caller's update may arrive inside
    /// an animation; a line growing token by token must not animate.
    private func updateInPlace(_ page: Page) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { shown = page }
    }

    private var dwellInterval: TimeInterval {
        Double(dwell.components.seconds) + Double(dwell.components.attoseconds) / 1e18
    }
}

extension InlinePager where Page: Hashable, ID == Page {
    /// Every distinct value is its own page.
    init(page: Page, dwell: Duration = .milliseconds(700), @ViewBuilder content: @escaping (Page) -> Content) {
        self.init(page: page, id: { $0 }, dwell: dwell, content: content)
    }
}
