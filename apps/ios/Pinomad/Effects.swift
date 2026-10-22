import SwiftUI

/// Light on the top edge only — a stroke masked to the upper half, not a
/// ring all the way round.
struct TopLip<S: InsettableShape>: View {
    let shape: S
    let color: Color

    var body: some View {
        shape.inset(by: 0.75)
            .strokeBorder(color, lineWidth: 1.5)
            .mask {
                LinearGradient(stops: [
                    .init(color: .white, location: 0),
                    .init(color: .clear, location: 0.45),
                ], startPoint: .top, endPoint: .bottom)
            }
            .allowsHitTesting(false)
    }
}

/// A field of grey dots in the strip under the composer while the agent
/// works: a slow wave of light runs across it, left to right. The clock
/// stops when it's off, so an idle page draws nothing; under Reduce Motion
/// the dots hold still.
struct WorkingDots: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let step: CGFloat = 7
    private let dot: CGFloat = 3

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !active || reduceMotion)) { timeline in
            let t = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                let columns = Int(size.width / step)
                let rows = Int(size.height / step)
                let inset = (size.width - CGFloat(columns) * step) / 2 + step / 2
                for column in 0..<columns {
                    let x = inset + CGFloat(column) * step
                    // A crest about a fifth of the width wide, crossing in ~2.4 s.
                    let phase = Double(x / size.width) * 5 - t * 2.1
                    let wave = (sin(phase) + 1) / 2
                    let lit = 0.14 + 0.62 * wave * wave * wave
                    for row in 0..<rows {
                        let y = step / 2 + CGFloat(row) * step
                        context.fill(
                            Path(ellipseIn: CGRect(x: x - dot / 2, y: y - dot / 2, width: dot, height: dot)),
                            with: .color(.secondary.opacity(lit))
                        )
                    }
                }
            }
        }
        .transaction { $0.animation = nil }
        // Fades in from the composer side so the strip has no hard top edge.
        .mask(LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .init(x: 0.5, y: 0.6)))
        .opacity(active ? 1 : 0)
        .animation(.easeInOut(duration: active ? 0.8 : 0.6), value: active)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
