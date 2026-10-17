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
                content.overlay {
                    content
                        .foregroundStyle(.primary)
                        .mask {
                            LinearGradient(
                                stops: [
                                    .init(color: .clear, location: 0),
                                    .init(color: .black, location: 0.5),
                                    .init(color: .clear, location: 1),
                                ],
                                startPoint: UnitPoint(x: t * 2.4 - 1.2, y: 0.5),
                                endPoint: UnitPoint(x: t * 2.4 - 0.2, y: 0.5)
                            )
                        }
                }
            }
        } else {
            content
        }
    }
}
