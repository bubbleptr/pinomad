import Markdown

/// One top-level Markdown block of a stream.
// swift-markdown trees are immutable once parsed, so a block can cross actors.
public struct MarkdownBlock: Identifiable, @unchecked Sendable {
    /// Position in the document; stable for the life of the stream.
    public let id: Int
    /// What the views draw, already converted from the parser's tree.
    public let content: MarkdownContent
    /// A closed block never changes again, and is never parsed again.
    public let isClosed: Bool
    /// The parser's tree, kept for the streaming tests that compare structure.
    let markup: any BlockMarkup

    init(id: Int, markup: any BlockMarkup, isClosed: Bool) {
        self.id = id
        self.markup = markup
        self.content = MarkdownContent(markup)
        self.isClosed = isClosed
    }
}

extension MarkdownBlock: Equatable {
    /// Compares the parser's O(1) node identity instead of walking the
    /// converted content, which the views compare on every stream update.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.markup.isIdentical(to: rhs.markup)
    }
}

/// Markdown that arrives a token at a time, as a language model writes it.
///
/// Appending parses only the text from the first open block on, so a token
/// costs the same at the end of a long reply as at its start. The finished
/// stream matches CommonMark, except that a link reference definition only
/// applies within the block it was streamed with.
public struct MarkdownStream: Sendable {
    public private(set) var blocks: [MarkdownBlock] = []
    public private(set) var isFinished = false
    private var source = ""
    /// UTF-8 offset in `source` where the open tail starts; everything before
    /// it is closed. An offset, not an index, so appending never invalidates it.
    private var tailOffset = 0

    public init() {}

    public mutating func append(_ text: String) {
        precondition(!isFinished, "append after finish")
        source += text
        reparseTail()
    }

    public mutating func finish() {
        isFinished = true
        reparseTail()
    }

    private mutating func reparseTail() {
        let tail = source[source.utf8.index(source.startIndex, offsetBy: tailOffset)...]
        let children = Array(Document(parsing: MathSyntax.protect(String(tail))).blockChildren)
        // Until the last block's first line ends, it may still turn into an
        // item of the list before it ("3" becoming "3. "), so that block stays
        // open too.
        let lastStartLine = children.last?.range?.lowerBound.line ?? 1
        let lineBreaks = MarkdownLines.lineBreakCount(in: tail.utf8)
        let openCount = isFinished ? 0 : lineBreaks >= lastStartLine ? 1 : 2
        let closedCount = max(children.count - openCount, 0)

        var kept = blocks.prefix { $0.isClosed }
        for markup in children.prefix(closedCount) {
            kept.append(MarkdownBlock(id: kept.count, markup: markup, isClosed: true))
        }

        if closedCount < children.count, let line = children[closedCount].range?.lowerBound.line {
            tailOffset += MarkdownLines.offset(ofLine: line, in: tail.utf8)
            let open = source[source.utf8.index(source.startIndex, offsetBy: tailOffset)...]
            for markup in Document(parsing: Speculation.complete(MathSyntax.protect(String(open)))).blockChildren {
                kept.append(MarkdownBlock(id: kept.count, markup: markup, isClosed: false))
            }
        } else if children.isEmpty, !isFinished {
            // Whitespace alone has no block yet, but may still start an
            // indented code block: keep it as the tail instead of dropping it.
        } else {
            tailOffset = source.utf8.count
        }
        blocks = Array(kept)
    }
}
