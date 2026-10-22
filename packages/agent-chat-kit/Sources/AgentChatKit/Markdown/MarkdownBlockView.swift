import AgentChatCore
import SwiftUI

/// One block of Markdown, recursing into lists and quotes.
struct MarkdownBlockView: View {
    let content: MarkdownContent

    var body: some View {
        switch content {
        case let .paragraph(inline):
            SwiftUI.Text(InlineText.attributed(inline))
                .fixedSize(horizontal: false, vertical: true)
                .fadingTail()
        case let .heading(level, inline):
            SwiftUI.Text(InlineText.attributed(inline))
                .font(Self.font(ofHeading: level))
                .fadingTail()
                .padding(.top, level <= 2 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
        case let .codeBlock(language, code):
            CodeBlockView(language: language, code: code)
        case let .list(list):
            ListView(list: list)
        case let .blockQuote(children):
            HStack(alignment: .top, spacing: 12) {
                Capsule().fill(.quaternary).frame(width: 3)
                BlockStack(contents: children)
            }
            .foregroundStyle(.secondary)
        case let .table(table):
            TableView(table: table)
                .environment(\.tailFade, nil)
        case .thematicBreak:
            Divider().padding(.vertical, 4)
        case let .html(html):
            // Raw HTML shows as text, so a reply cannot hide anything.
            SwiftUI.Text(html.trimmingCharacters(in: .newlines))
                .font(.callout.monospaced())
                .foregroundStyle(.secondary)
        case let .group(children):
            BlockStack(contents: children)
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
    let contents: [MarkdownContent]
    @Environment(\.tailFade) private var tailFade

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(contents.enumerated()), id: \.offset) { index, content in
                MarkdownBlockView(content: content)
                    .environment(\.tailFade, index == contents.count - 1 ? tailFade : nil)
            }
        }
    }
}

private struct ListView: View {
    let list: MarkdownList
    @Environment(\.tailFade) private var tailFade

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(for: item, at: index)
                    BlockStack(contents: item.blocks)
                }
                .environment(\.tailFade, index == list.items.count - 1 ? tailFade : nil)
            }
        }
    }

    @ViewBuilder
    private func marker(for item: MarkdownListItem, at index: Int) -> some View {
        if let checked = item.checkbox {
            Image(checked ? Icon.squareCheck : .square)
                .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .accessibilityLabel(checked ? Text("Done", bundle: .module) : Text("Not done", bundle: .module))
        } else if list.isOrdered {
            SwiftUI.Text("\(list.start + index).")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        } else {
            SwiftUI.Text("•").foregroundStyle(.secondary)
        }
    }
}
