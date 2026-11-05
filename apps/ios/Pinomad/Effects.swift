import SwiftUI
import UIKit

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

/// Blur under the composer bar that deepens toward the screen's bottom
/// edge. The system's soft scroll edge only fades the transcript under a
/// bar that holds glass, so the bar brings its own blur; a material with a
/// gradient mask only hazes the text instead of blurring it.
///
/// Core Animation's variable blur is not public API. If the filter is
/// unavailable, nothing is drawn and the edge falls back to the system fade.
struct BottomEdgeBlur: UIViewRepresentable {
    var radius: CGFloat = 6

    func makeUIView(context: Context) -> VariableBlurView {
        VariableBlurView(radius: radius)
    }

    func updateUIView(_ view: VariableBlurView, context: Context) {}
}

final class VariableBlurView: UIVisualEffectView {
    private let radius: CGFloat

    init(radius: CGFloat) {
        self.radius = radius
        super.init(effect: UIBlurEffect(style: .regular))
        isUserInteractionEnabled = false
        // UIKit rebuilds the effect's layers after an appearance change,
        // after this handler runs; apply the filter once it has.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: VariableBlurView, _) in
            DispatchQueue.main.async { view.applyFilter() }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        applyFilter()
    }

    private func applyFilter() {
        guard window != nil,
              let backdrop = subviews.first?.layer,
              let filter = Self.makeFilter(radius: radius)
        else { return }
        backdrop.filters = [filter]
        // Drop the material's tint and grain; keep only the blur.
        for overlay in subviews.dropFirst() { overlay.alpha = 0 }
    }

    private static func makeFilter(radius: CGFloat) -> NSObject? {
        guard let filterClass = NSClassFromString("CAFilter") as? NSObject.Type else { return nil }
        let make = NSSelectorFromString("filterWithType:")
        guard filterClass.responds(to: make),
              let filter = filterClass.perform(make, with: "variableBlur")?.takeUnretainedValue() as? NSObject
        else { return nil }
        filter.setValue(radius, forKey: "inputRadius")
        filter.setValue(mask, forKey: "inputMaskImage")
        filter.setValue(true, forKey: "inputNormalizeEdges")
        return filter
    }

    /// Clear at the top of the bar, full strength from about halfway down.
    /// The filter stretches the mask over the view, so a small image is enough.
    private static let mask: CGImage? = {
        let size = CGSize(width: 1, height: 64)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            let colors = [UIColor.clear.cgColor, UIColor.black.cgColor] as CFArray
            guard let gradient = CGGradient(colorsSpace: nil, colors: colors, locations: [0, 0.5]) else { return }
            context.cgContext.drawLinearGradient(
                gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: .drawsAfterEndLocation)
        }
        return image.cgImage
    }()
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
