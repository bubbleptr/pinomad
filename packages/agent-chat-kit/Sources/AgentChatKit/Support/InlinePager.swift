import SwiftUI

/// A one-line viewport whose pages flip vertically — the old one rises out,
/// the new one enters from below. For step labels that change while a step
/// is live: the running call's name, a batch turning into its summary. Each
/// page dwells at least `dwell` before the next may replace it; pages that
/// arrive during the wait are dropped rather than queued.
struct InlinePager<Page: Hashable, Content: View>: View {
    let page: Page
    var dwell: Duration = .milliseconds(700)
    @ViewBuilder var content: (Page) -> Content

    @State private var shown: Page
    @State private var latest: Page
    @State private var shownAt = Date.now
    @State private var flip: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(page: Page, dwell: Duration = .milliseconds(700), @ViewBuilder content: @escaping (Page) -> Content) {
        self.page = page
        self.dwell = dwell
        self.content = content
        _shown = State(initialValue: page)
        _latest = State(initialValue: page)
    }

    var body: some View {
        ZStack(alignment: .leading) {
            content(shown)
                .id(shown)
                .transition(.push(from: .bottom))
        }
        .clipped()
        .onChange(of: page) { _, newPage in
            latest = newPage
            // A scheduled flip picks up whatever is latest when it fires.
            guard newPage != shown, flip == nil else { return }
            let wait = dwellInterval - Date.now.timeIntervalSince(shownAt)
            flip = Task {
                if wait > 0 { try? await Task.sleep(for: .milliseconds(Int(wait * 1000))) }
                guard !Task.isCancelled else { return }
                flip = nil
                guard latest != shown else { return }
                shownAt = .now
                if reduceMotion {
                    shown = latest
                } else {
                    withAnimation(.easeInOut(duration: 0.25)) { shown = latest }
                }
            }
        }
        .onDisappear { flip?.cancel() }
    }

    private var dwellInterval: TimeInterval {
        Double(dwell.components.seconds) + Double(dwell.components.attoseconds) / 1e18
    }
}
