import AgentChatCore
import Markdown
import SwiftUI

/// Markdown, finished or still streaming in. Feed it the stream's blocks as
/// they change; closed blocks are not rendered again.
public struct MarkdownView: View {
    let blocks: [MarkdownBlock]

    public init(_ stream: MarkdownStream) {
        blocks = stream.blocks
    }

    /// A finished document.
    public init(markdown: String) {
        var stream = MarkdownStream()
        stream.append(markdown)
        stream.finish()
        blocks = stream.blocks
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks) { block in
                BlockCell(block: block)
                    .equatable()
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Skips re-rendering a block whose markup has not changed.
private struct BlockCell: View, Equatable {
    nonisolated let block: MarkdownBlock

    var body: some View {
        MarkdownBlockView(markup: block.markup)
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block.id == rhs.block.id && lhs.block.markup.isIdentical(to: rhs.block.markup)
    }
}
