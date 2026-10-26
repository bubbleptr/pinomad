import Markdown

/// Markdown as plain text, for the clipboard: blank lines between blocks, a
/// list's items on lines of their own, a table's cells separated by tabs,
/// code as written.
public enum PlainText {
    public static func of(markdown: String) -> String {
        blocks(Document(parsing: MathSyntax.protect(markdown)).children, indent: "")
    }

    private static func blocks(_ children: MarkupChildren, indent: String) -> String {
        children.map { block($0, indent: indent) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    private static func block(_ markup: any Markup, indent: String) -> String {
        switch markup {
        case let code as CodeBlock where code.language == MathSyntax.fenceLanguage:
            return indent + "$$" + code.code.trimmingCharacters(in: .newlines) + "$$"
        case let code as CodeBlock:
            return indented(code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code, by: indent)
        case let list as UnorderedList:
            return items(Array(list.listItems), indent: indent) { _ in "• " }
        case let list as OrderedList:
            return items(Array(list.listItems), indent: indent) { "\(Int(list.startIndex) + $0). " }
        case let quote as BlockQuote:
            return blocks(quote.children, indent: indent)
        case let table as Markdown.Table:
            let rows = [table.head.cells.map(inline)] + table.body.rows.map { $0.cells.map(inline) }
            return rows.map { indent + $0.joined(separator: "\t") }.joined(separator: "\n")
        case is ThematicBreak:
            return ""
        case let html as HTMLBlock:
            return indented(html.rawHTML.trimmingSuffix(while: { $0.isNewline }), by: indent)
        default:
            return indent + inline(markup)
        }
    }

    private static func items(_ items: [ListItem], indent: String, marker: (Int) -> String) -> String {
        items.enumerated().map { index, item in
            let children = Array(item.children)
            let mark = item.checkbox.map { $0 == .checked ? "☑ " : "☐ " } ?? marker(index)
            let first = children.first.map { block($0, indent: "") } ?? ""
            let rest = children.dropFirst().map { block($0, indent: indent + "  ") }
            return ([indent + mark + first] + rest).joined(separator: "\n")
        }.joined(separator: "\n")
    }

    private static func inline(_ markup: any Markup) -> String {
        switch markup {
        case let text as Markdown.Text: text.string
        case is SoftBreak: " "
        case is LineBreak: "\n"
        case let code as InlineCode:
            switch code.code.first {
            case MathSyntax.inlineMark?: "$" + code.code.dropFirst() + "$"
            case MathSyntax.displayMark?: "$$" + code.code.dropFirst() + "$$"
            default: code.code
            }
        case let html as InlineHTML: html.rawHTML
        default: markup.children.map(inline).joined()
        }
    }

    private static func indented(_ text: String, by indent: String) -> String {
        indent.isEmpty ? text : text.split(separator: "\n", omittingEmptySubsequences: false).map { indent + $0 }.joined(separator: "\n")
    }
}

private extension String {
    func trimmingSuffix(while predicate: (Character) -> Bool) -> String {
        var result = self
        while let last = result.last, predicate(last) { result.removeLast() }
        return result
    }
}
