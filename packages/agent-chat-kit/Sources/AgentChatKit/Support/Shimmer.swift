import SwiftUI

extension View {
    /// A band of light sweeping across, for text that names work in progress.
    func shimmering(_ active: Bool) -> some View {
        modifier(Shimmer(active: active))
    }
}

private struct Shimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if active, !reduceMotion {
            TimelineView(.animation) { context in
                let period = 1.8
                let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                // The band is the text's own fill, not a second copy laid
                // over it: a copy is laid out on its own and, once the line
                // truncates, lands at a different width and drifts sideways.
                content.foregroundStyle(
                    LinearGradient(
                        stops: [
                            .init(color: .secondary, location: 0),
                            .init(color: .primary, location: 0.5),
                            .init(color: .secondary, location: 1),
                        ],
                        startPoint: UnitPoint(x: t * 2.4 - 1.2, y: 0.5),
                        endPoint: UnitPoint(x: t * 2.4 - 0.2, y: 0.5)
                    )
                )
            }
        } else {
            content
        }
    }
}
