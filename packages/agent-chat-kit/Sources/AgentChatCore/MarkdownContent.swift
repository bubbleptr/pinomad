import Foundation
import Markdown

/// A block of Markdown converted into the data the views draw. AgentChatKit
/// consumes this instead of the parser's tree, so it depends on AgentChatCore
/// and not on swift-markdown.
public indirect enum MarkdownContent: Sendable, Equatable {
    case paragraph(MarkdownInline)
    case heading(level: Int, text: MarkdownInline)
    case codeBlock(language: String?, code: String)
    case list(MarkdownList)
    case blockQuote([MarkdownContent])
    case table(MarkdownTable)
    case thematicBreak
    case html(String)
    /// A container whose children are all the block structure it has.
    case group([MarkdownContent])

    init(_ markup: any Markup) {
        switch markup {
        case let paragraph as Paragraph:
            self = .paragraph(MarkdownInline(paragraph))
        case let heading as Heading:
            self = .heading(level: heading.level, text: MarkdownInline(heading))
        case let code as CodeBlock:
            self = .codeBlock(language: code.language, code: code.code)
        case let list as UnorderedList:
            self = .list(MarkdownList(list, isOrdered: false, start: 0))
        case let list as OrderedList:
            self = .list(MarkdownList(list, isOrdered: true, start: Int(list.startIndex)))
        case let quote as BlockQuote:
            self = .blockQuote(quote.blockChildren.map(MarkdownContent.init))
        case let table as Markdown.Table:
            self = .table(MarkdownTable(table))
        case is ThematicBreak:
            self = .thematicBreak
        case let html as HTMLBlock:
            self = .html(html.rawHTML)
        default:
            self = .group((markup as? any BlockContainer)?.blockChildren.map(MarkdownContent.init) ?? [])
        }
    }
}

/// Inline Markdown as presentation runs: what to draw, and the style each
/// run carries. The view turns this into an AttributedString.
public struct MarkdownInline: Sendable, Equatable {
    public let runs: [MarkdownInlineRun]

    init(_ markup: any Markup) {
        var runs: [MarkdownInlineRun] = []
        Self.append(markup, to: &runs)
        self.runs = runs
    }

    private static func append(
        _ markup: any Markup,
        strong: Bool = false,
        emphasized: Bool = false,
        strikethrough: Bool = false,
        code: Bool = false,
        link: URL? = nil,
        pendingLink: Bool = false,
        to runs: inout [MarkdownInlineRun]
    ) {
        func run(_ text: String, code textIsCode: Bool = false, link runLink: URL? = link, pending pendingLink: Bool = pendingLink) {
            runs.append(MarkdownInlineRun(
                text: text,
                isStrong: strong,
                isEmphasized: emphasized,
                isStrikethrough: strikethrough,
                isCode: textIsCode,
                link: runLink,
                isPendingLink: pendingLink
            ))
        }

        switch markup {
        case let text as Markdown.Text:
            run(text.string)
        case is SoftBreak:
            run(" ")
        case is LineBreak:
            run("\n")
        case let codeMarkup as InlineCode:
            run(codeMarkup.code, code: true)
        case let html as InlineHTML:
            run(html.rawHTML)
        case let image as Markdown.Image:
            for child in image.children {
                append(child, strong: strong, emphasized: emphasized, strikethrough: strikethrough, code: code, link: link, pendingLink: pendingLink, to: &runs)
            }
        case let linkMarkup as Markdown.Link:
            let destination = linkMarkup.destination.flatMap { $0.isEmpty ? nil : URL(string: $0) }
            for child in linkMarkup.children {
                append(
                    child,
                    strong: strong,
                    emphasized: emphasized,
                    strikethrough: strikethrough,
                    code: code,
                    link: destination,
                    pendingLink: destination == nil,
                    to: &runs
                )
            }
        case is Strong:
            for child in markup.children {
                append(child, strong: true, emphasized: emphasized, strikethrough: strikethrough, code: code, link: link, pendingLink: pendingLink, to: &runs)
            }
        case is Emphasis:
            for child in markup.children {
                append(child, strong: strong, emphasized: true, strikethrough: strikethrough, code: code, link: link, pendingLink: pendingLink, to: &runs)
            }
        case is Strikethrough:
            for child in markup.children {
                append(child, strong: strong, emphasized: emphasized, strikethrough: true, code: code, link: link, pendingLink: pendingLink, to: &runs)
            }
        default:
            for child in markup.children {
                append(child, strong: strong, emphasized: emphasized, strikethrough: strikethrough, code: code, link: link, pendingLink: pendingLink, to: &runs)
            }
        }
    }
}

/// One styled span of inline Markdown.
public struct MarkdownInlineRun: Sendable, Equatable {
    public let text: String
    public let isStrong: Bool
    public let isEmphasized: Bool
    public let isStrikethrough: Bool
    public let isCode: Bool
    public let link: URL?
    /// A link whose destination has not fully arrived: styled, not tappable.
    public let isPendingLink: Bool
}

public struct MarkdownList: Sendable, Equatable {
    public let isOrdered: Bool
    /// Number of the first item; zero for a bulleted list.
    public let start: Int
    public let items: [MarkdownListItem]

    init(_ list: any ListItemContainer, isOrdered: Bool, start: Int) {
        self.isOrdered = isOrdered
        self.start = start
        items = list.listItems.map { item in
            MarkdownListItem(
                checkbox: item.checkbox.map { $0 == .checked },
                blocks: item.blockChildren.map(MarkdownContent.init)
            )
        }
    }
}

public struct MarkdownListItem: Sendable, Equatable {
    /// Whether a task box is checked; nil for an item without one.
    public let checkbox: Bool?
    public let blocks: [MarkdownContent]
}

public struct MarkdownTable: Sendable, Equatable {
    public let header: [MarkdownInline]
    public let rows: [[MarkdownInline]]
    public let alignments: [MarkdownTableAlignment]

    init(_ table: Markdown.Table) {
        header = table.head.cells.map(MarkdownInline.init)
        rows = table.body.rows.map { $0.cells.map(MarkdownInline.init) }
        alignments = table.columnAlignments.map { alignment in
            switch alignment {
            case .center: .center
            case .right: .trailing
            default: .leading
            }
        }
    }
}

public enum MarkdownTableAlignment: Sendable, Equatable {
    case leading, center, trailing
}
