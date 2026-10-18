import AgentChatCore
import SwiftUI

/// Markdown, finished or still streaming in. Closed blocks are not rendered
/// again as the stream grows.
public struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    let tailFade: [Double]?

    public init(_ stream: MarkdownStream) {
        self.init(blocks: stream.blocks, tailFade: nil)
    }

    /// A finished document.
    public init(markdown: String) {
        var stream = MarkdownStream()
        stream.append(markdown)
        stream.finish()
        self.init(blocks: stream.blocks, tailFade: nil)
    }

    init(blocks: [MarkdownBlock], tailFade: [Double]?) {
        self.blocks = blocks
        self.tailFade = tailFade
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks) { block in
                BlockCell(block: block, tailFade: block.id == blocks.last?.id ? tailFade : nil)
                    .equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Each block selects on its own: SwiftUI cannot select across texts.
        .textSelection(.enabled)
    }
}

/// A reply streaming in, revealed a word at a time with each word fading in.
public struct StreamingMarkdownView: View {
    let markdown: StreamingMarkdown
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ markdown: StreamingMarkdown) {
        self.markdown = markdown
    }

    public var body: some View {
        let fades = markdown.isAnimating && !reduceMotion
        TimelineView(.animation(paused: !fades)) { context in
            MarkdownView(blocks: markdown.stream.blocks, tailFade: fades ? markdown.tailOpacities(at: context.date) : nil)
        }
    }
}

/// Skips re-rendering a block whose markup has not changed and that is not fading in.
private struct BlockCell: View, Equatable {
    nonisolated let block: MarkdownBlock
    nonisolated let tailFade: [Double]?

    var body: some View {
        MarkdownBlockView(content: block.content)
            .environment(\.tailFade, tailFade)
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block == rhs.block && lhs.tailFade == rhs.tailFade
    }
}
