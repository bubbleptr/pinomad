import AgentChatCore
import Foundation
import SwiftUI

/// Inline Markdown as one attributed string, so a paragraph stays a single
/// `Text`: it wraps, selects and scales with Dynamic Type as one.
enum InlineText {
    /// `font` is the text's own font, resolved: CJK quotes take its size
    /// and weight in a CJK typeface.
    @MainActor
    static func text(_ inline: MarkdownInline, font: Font.Resolved) -> SwiftUI.Text {
        guard inline.runs.contains(where: { $0.math != nil }) else {
            return SwiftUI.Text(attributed(inline.runs, font: font))
        }
        // Formulas are images inside the text, so the paragraph still wraps as one.
        var result = SwiftUI.Text(verbatim: "")
        var prose: [MarkdownInlineRun] = []
        for run in inline.runs {
            guard let math = run.math else {
                prose.append(run)
                continue
            }
            if !prose.isEmpty {
                result = SwiftUI.Text("\(result)\(SwiftUI.Text(attributed(prose, font: font)))")
                prose = []
            }
            result = SwiftUI.Text("\(result)\(MathText.text(run.text, display: math == .display, font: font))")
        }
        if !prose.isEmpty {
            result = SwiftUI.Text("\(result)\(SwiftUI.Text(attributed(prose, font: font)))")
        }
        return result
    }

    static func attributed(_ runs: [MarkdownInlineRun], font: Font.Resolved) -> AttributedString {
        var result = AttributedString()
        for run in runs {
            var string = AttributedString(run.text)
            var intent: InlinePresentationIntent = []
            if run.isStrong { intent.insert(.stronglyEmphasized) }
            if run.isEmphasized { intent.insert(.emphasized) }
            if run.isStrikethrough { intent.insert(.strikethrough) }
            if run.isCode { intent.insert(.code) }
            if !intent.isEmpty { string.inlinePresentationIntent = intent }
            if let link = run.link { string.link = link }
            if run.isCode { string.backgroundColor = Color.secondary.opacity(0.12) }
            if run.isPendingLink { string.foregroundColor = .accentColor }
            if run.isCJKQuote {
                string.font = .custom("PingFang SC", fixedSize: font.pointSize)
                    .weight(run.isStrong ? .bold : font.weight)
            }
            result += string
        }
        return result
    }
}
