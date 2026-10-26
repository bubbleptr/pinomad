import AgentChatCore
import SwiftMath
import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A formula as text: drawn pieces lowered onto the baseline, CJK prose
/// between them in the text font, and its source as written if the
/// renderer can't read it.
enum MathText {
    @MainActor
    static func text(_ latex: String, display: Bool, font: Font.Resolved) -> SwiftUI.Text {
        let size = font.pointSize * scale
        var pieces: [SwiftUI.Text] = []
        for segment in MathLayout.segments(of: latex) {
            switch segment {
            case let .text(prose):
                // The renderer drops spacing at a formula's end (`\;\to\;`),
                // so prose after a formula piece would touch it.
                pieces.append(SwiftUI.Text(verbatim: pieces.isEmpty ? prose : "\u{2009}" + prose))
            case let .latex(source):
                guard let drawn = MathRenderer.render(source, size: size, display: display) else {
                    return SwiftUI.Text(verbatim: display ? "$$\(latex)$$" : "$\(latex)$")
                }
                pieces.append(SwiftUI.Text(drawn.image).baselineOffset(-drawn.descent))
            }
        }
        return pieces.reduce(SwiftUI.Text(verbatim: "")) { SwiftUI.Text("\($0)\($1)") }
    }

    /// Latin Modern's x-height is smaller than the system font's; at the
    /// same point size a formula looks a size too small next to the text.
    static let scale: CGFloat = 1.12
}

/// A formula on its own line, centred, scrolling sideways when it is wider
/// than the reply.
struct MathBlockView: View {
    let latex: String
    @Environment(\.font) private var font
    @Environment(\.fontResolutionContext) private var fontContext
    @State private var width: CGFloat = 0

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            formula
                .fixedSize()
                .padding(.vertical, 4)
                .frame(minWidth: width)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    /// A formula alone is drawn as an image: lowering it onto a text
    /// baseline would leave its descent as empty space above it.
    @ViewBuilder
    private var formula: some View {
        let resolved = (font ?? .body).resolve(in: fontContext)
        let segments = MathLayout.segments(of: latex)
        if segments.count == 1, case let .latex(source) = segments[0],
           let drawn = MathRenderer.render(source, size: resolved.pointSize * MathText.scale, display: true) {
            drawn.image
        } else {
            MathText.text(latex, display: true, font: resolved)
        }
    }
}

/// Formulas drawn once per size and style: a streaming paragraph lays out
/// again on every token.
@MainActor
enum MathRenderer {
    final class Drawn {
        let image: Image
        /// How far the formula reaches below the baseline.
        let descent: CGFloat

        init(image: Image, descent: CGFloat) {
            self.image = image
            self.descent = descent
        }
    }

    private static let cache = NSCache<NSString, Drawn>()
    /// Sources that failed to parse, so a broken formula isn't parsed again each frame.
    private static let failures = NSCache<NSString, NSNull>()

    static func render(_ latex: String, size: CGFloat, display: Bool) -> Drawn? {
        let key = "\(display ? "D" : "T")\(size)|\(latex)" as NSString
        if let drawn = cache.object(forKey: key) { return drawn }
        if failures.object(forKey: key) != nil { return nil }
        // Drawn black and used as a template, so it takes the text's color.
        var math = MathImage(latex: latex, fontSize: size, textColor: .black,
                             labelMode: display ? .display : .text, textAlignment: .left)
        let (error, image, layout) = math.asImage()
        guard error == nil, let image, let layout, let bitmap = bitmap(of: image) else {
            failures.setObject(NSNull(), forKey: key)
            return nil
        }
        // Inside a Text an image is read by its own label: VoiceOver reads
        // the TeX in its place and the prose around it as written.
        let labelled = Image(bitmap.image, scale: bitmap.scale, label: SwiftUI.Text(verbatim: latex))
        let drawn = Drawn(image: labelled.renderingMode(.template), descent: layout.descent)
        cache.setObject(drawn, forKey: key)
        return drawn
    }

    #if canImport(UIKit)
    private static func bitmap(of image: UIImage) -> (image: CGImage, scale: CGFloat)? {
        image.cgImage.map { ($0, image.scale) }
    }
    #else
    private static func bitmap(of image: NSImage) -> (image: CGImage, scale: CGFloat)? {
        image.cgImage(forProposedRect: nil, context: nil, hints: nil).map { ($0, CGFloat($0.width) / image.size.width) }
    }
    #endif
}
