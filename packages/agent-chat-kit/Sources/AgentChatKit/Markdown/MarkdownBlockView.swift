import Markdown
import SwiftUI

/// One block of Markdown, recursing into lists and quotes.
struct MarkdownBlockView: View {
    let markup: any Markup

    var body: some View {
        switch markup {
        case let paragraph as Paragraph:
            SwiftUI.Text(InlineText.attributed(paragraph))
                .fixedSize(horizontal: false, vertical: true)
                .fadingTail()
        case let heading as Heading:
            SwiftUI.Text(InlineText.attributed(heading))
                .font(Self.font(ofHeading: heading.level))
                .fadingTail()
                .padding(.top, heading.level <= 2 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
        case let code as CodeBlock:
            CodeBlockView(language: code.language, code: code.code)
        case let list as UnorderedList:
            ListView(items: Array(list.listItems), start: nil)
        case let list as OrderedList:
            ListView(items: Array(list.listItems), start: Int(list.startIndex))
        case let quote as BlockQuote:
            HStack(alignment: .top, spacing: 12) {
                Capsule().fill(.quaternary).frame(width: 3)
                BlockStack(parent: quote)
            }
            .foregroundStyle(.secondary)
        case let table as Markdown.Table:
            TableView(table: table)
                .environment(\.tailFade, nil)
        case is ThematicBreak:
            Divider().padding(.vertical, 4)
        case let html as HTMLBlock:
            // Raw HTML shows as text, so a reply cannot hide anything.
            SwiftUI.Text(html.rawHTML.trimmingCharacters(in: .newlines))
                .font(.callout.monospaced())
                .foregroundStyle(.secondary)
        default:
            BlockStack(parent: markup)
        }
    }

    private static func font(ofHeading level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.semibold)
        case 2: .title3.weight(.semibold)
        default: .headline
        }
    }
}

/// The block children of a container, stacked. Only the last child can be
/// the one still streaming in.
struct BlockStack: View {
    let parent: any Markup
    @Environment(\.tailFade) private var tailFade

    var body: some View {
        let count = parent.childCount
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parent.children.enumerated()), id: \.offset) { index, child in
                MarkdownBlockView(markup: child)
                    .environment(\.tailFade, index == count - 1 ? tailFade : nil)
            }
        }
    }
}

private struct ListView: View {
    let items: [ListItem]
    /// Number of the first item; nil for a bulleted list.
    let start: Int?
    @Environment(\.tailFade) private var tailFade

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(for: item, at: index)
                    BlockStack(parent: item)
                }
                .environment(\.tailFade, index == items.count - 1 ? tailFade : nil)
            }
        }
    }

    @ViewBuilder
    private func marker(for item: ListItem, at index: Int) -> some View {
        if let checkbox = item.checkbox {
            Image(systemName: checkbox == .checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checkbox == .checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .accessibilityLabel(checkbox == .checked ? "Done" : "Not done")
        } else if let start {
            SwiftUI.Text("\(start + index).")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        } else {
            SwiftUI.Text("•").foregroundStyle(.secondary)
        }
    }
}
