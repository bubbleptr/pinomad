import Markdown
import SwiftUI

/// Inline Markdown as one attributed string, so a paragraph stays a single
/// `Text`: it wraps, selects and scales with Dynamic Type as one.
enum InlineText {
    static func attributed(_ markup: any Markup) -> AttributedString {
        var result = AttributedString()
        for child in markup.children {
            result += attributed(child, intent: [])
        }
        return result
    }

    private static func attributed(_ markup: any Markup, intent: InlinePresentationIntent) -> AttributedString {
        switch markup {
        case let text as Markdown.Text:
            return run(text.string, intent: intent)
        case is SoftBreak:
            return run(" ", intent: intent)
        case is LineBreak:
            return run("\n", intent: intent)
        case let code as InlineCode:
            var string = run(code.code, intent: intent.union(.code))
            string.backgroundColor = Color.secondary.opacity(0.12)
            return string
        case let html as InlineHTML:
            return run(html.rawHTML, intent: intent)
        case let image as Markdown.Image:
            return children(of: image, intent: intent)
        case let link as Markdown.Link:
            var string = children(of: link, intent: intent)
            // A destination still streaming in is empty: styled, not tappable yet.
            if let destination = link.destination, !destination.isEmpty, let url = URL(string: destination) {
                string.link = url
            } else {
                string.foregroundColor = .accentColor
            }
            return string
        case is Strong:
            return children(of: markup, intent: intent.union(.stronglyEmphasized))
        case is Emphasis:
            return children(of: markup, intent: intent.union(.emphasized))
        case is Strikethrough:
            return children(of: markup, intent: intent.union(.strikethrough))
        default:
            return children(of: markup, intent: intent)
        }
    }

    private static func children(of markup: any Markup, intent: InlinePresentationIntent) -> AttributedString {
        var result = AttributedString()
        for child in markup.children {
            result += attributed(child, intent: intent)
        }
        return result
    }

    private static func run(_ string: String, intent: InlinePresentationIntent) -> AttributedString {
        var result = AttributedString(string)
        if !intent.isEmpty { result.inlinePresentationIntent = intent }
        return result
    }
}
