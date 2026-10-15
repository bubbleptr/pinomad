import Markdown

/// One top-level Markdown block of a stream.
public struct MarkdownBlock: Identifiable {
    /// Position in the document; stable for the life of the stream.
    public let id: Int
    public let markup: any BlockMarkup
    /// A closed block never changes again; only the last block can be open.
    public let isClosed: Bool
}

/// Markdown that arrives a token at a time, as a language model writes it.
public struct MarkdownStream {
    public private(set) var blocks: [MarkdownBlock] = []
    public private(set) var isFinished = false
    private var source = ""

    public init() {}

    public mutating func append(_ text: String) {
        source += text
        reparse()
    }

    public mutating func finish() {
        isFinished = true
        reparse()
    }

    private mutating func reparse() {
        let children = Array(Document(parsing: source).blockChildren)
        // Until the last block's first line ends, it may still turn into an
        // item of the list before it ("3" becoming "3. "), so that block stays
        // open too.
        let lastStartLine = children.last?.range?.lowerBound.line ?? 1
        let newlines = source.utf8.count { $0 == UInt8(ascii: "\n") }
        let openCount = newlines >= lastStartLine ? 1 : 2
        blocks = children.enumerated().map { index, markup in
            MarkdownBlock(id: index, markup: markup, isClosed: isFinished || index < children.count - openCount)
        }
    }
}
