import SwiftUI

extension EnvironmentValues {
    /// Opacity of the last glyphs of the innermost last text, last glyph
    /// first; set only along the path to the text still streaming in.
    @Entry var tailFade: [Double]? = nil
}

extension View {
    /// Fades in the newest glyphs of the text inside, when it is the text
    /// still streaming in.
    func fadingTail() -> some View {
        modifier(FadingTail())
    }
}

private struct FadingTail: ViewModifier {
    @Environment(\.tailFade) private var opacities

    func body(content: Content) -> some View {
        if let opacities, !opacities.isEmpty {
            content.textRenderer(TailFadeRenderer(opacities: opacities))
        } else {
            content
        }
    }
}

/// Draws glyphs one by one only near the end; the rest of the text is drawn
/// a run at a time, as usual.
private struct TailFadeRenderer: TextRenderer {
    let opacities: [Double]

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let total = layout.reduce(0) { lines, line in lines + line.reduce(0) { $0 + $1.count } }
        var index = 0
        for line in layout {
            for run in line {
                let fromEnd = total - index - run.count
                index += run.count
                if fromEnd >= opacities.count {
                    context.draw(run)
                    continue
                }
                for glyph in run.indices {
                    let glyphFromEnd = total - (index - run.count) - (glyph - run.startIndex) - 1
                    var glyphContext = context
                    if glyphFromEnd < opacities.count { glyphContext.opacity = opacities[glyphFromEnd] }
                    glyphContext.draw(run[glyph..<(glyph + 1)])
                }
            }
        }
    }
}
