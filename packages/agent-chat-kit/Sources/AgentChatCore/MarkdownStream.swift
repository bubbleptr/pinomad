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
        blocks = children.enumerated().map { index, markup in
            MarkdownBlock(id: index, markup: markup, isClosed: isFinished || index < children.count - 1)
        }
    }
}
