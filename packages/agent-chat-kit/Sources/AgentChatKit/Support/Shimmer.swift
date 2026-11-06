import AgentChatCore
import SwiftUI

extension View {
    /// A band of light sweeping across, for text that names work in progress.
    /// `style` is the text's own style: the band's width and speed are in its
    /// ems, and `Text.font` doesn't reach the environment for this to read.
    func shimmering(_ active: Bool, relativeTo style: Font.TextStyle) -> some View {
        modifier(Shimmer(active: active, style: style))
    }
}

private struct Shimmer: ViewModifier {
    let active: Bool
    @ScaledMetric private var em: CGFloat
    /// The text's width as laid out (truncated, if it is), which sets how
    /// long a sweep takes.
    @State private var width: CGFloat = 0
    /// When the current sweep started; reset only when the width changes,
    /// since a restart mid-sweep would snap the band back.
    @State private var start = Date.now
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(active: Bool, style: Font.TextStyle) {
        self.active = active
        _em = ScaledMetric(wrappedValue: Self.pointSize(style), relativeTo: style)
    }

    func body(content: Content) -> some View {
        if active, !reduceMotion {
            TimelineView(.animation) { context in
                let sweep = ShimmerSweep(width: width, pointSize: em)
                let origin = sweep.bandOrigin(at: context.date.timeIntervalSince(start))
                let span = max(width, 1)
                // The band is the text's own fill, not a second copy laid
                // over it: a copy is laid out on its own and, once the line
                // truncates, lands at a different width and drifts sideways.
                // Outside the band the gradient pads with its end colour, so
                // the rest of the text reads secondary. (The web lightens its
                // resting colour toward disabled for contrast with the peak;
                // secondaryLabel is already about 3.4:1 on white, so lighter
                // would leave the label too faint.)
                content.foregroundStyle(
                    LinearGradient(
                        stops: [
                            .init(color: .secondary, location: 0),
                            .init(color: .primary, location: 0.5),
                            .init(color: .secondary, location: 1),
                        ],
                        startPoint: UnitPoint(x: origin / span, y: 0.5),
                        endPoint: UnitPoint(x: (origin + sweep.band) / span, y: 0.5)
                    )
                )
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { next in
                width = next
                start = .now
            }
        } else {
            content
        }
    }

    /// The style's size at the default Dynamic Type setting; `ScaledMetric`
    /// scales it with the reader's.
    private static func pointSize(_ style: Font.TextStyle) -> CGFloat {
        #if os(macOS)
        switch style {
        case .subheadline: 11
        case .callout: 12
        default: 13
        }
        #else
        switch style {
        case .subheadline: 15
        case .callout: 16
        default: 17
        }
        #endif
    }
}
