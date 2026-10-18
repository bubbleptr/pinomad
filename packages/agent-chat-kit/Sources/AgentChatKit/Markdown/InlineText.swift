import AgentChatCore
import Foundation
import SwiftUI

/// Inline Markdown as one attributed string, so a paragraph stays a single
/// `Text`: it wraps, selects and scales with Dynamic Type as one.
enum InlineText {
    static func attributed(_ inline: MarkdownInline) -> AttributedString {
        var result = AttributedString()
        for run in inline.runs {
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
            result += string
        }
        return result
    }
}
