import Markdown

/// One top-level Markdown block of a stream.
public struct MarkdownBlock: Identifiable {
    /// Position in the document; stable for the life of the stream.
    public let id: Int
    public let markup: any BlockMarkup
    /// A closed block never changes again, and is never parsed again.
    public let isClosed: Bool
}

/// Markdown that arrives a token at a time, as a language model writes it.
///
/// Appending parses only the text from the first open block on, so a token
/// costs the same at the end of a long reply as at its start. The finished
/// stream matches CommonMark, except that a link reference definition only
/// applies within the block it was streamed with.
public struct MarkdownStream {
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
        let children = Array(Document(parsing: String(tail)).blockChildren)
        // Until the last block's first line ends, it may still turn into an
        // item of the list before it ("3" becoming "3. "), so that block stays
        // open too.
        let lastStartLine = children.last?.range?.lowerBound.line ?? 1
        let newlines = tail.utf8.count { $0 == UInt8(ascii: "\n") }
        let openCount = isFinished ? 0 : newlines >= lastStartLine ? 1 : 2
        let closedCount = max(children.count - openCount, 0)

        var kept = blocks.prefix { $0.isClosed }
        for (offset, markup) in children.enumerated() {
            kept.append(MarkdownBlock(id: kept.count, markup: markup, isClosed: offset < closedCount))
        }
        blocks = Array(kept)

        if closedCount < children.count, let line = children[closedCount].range?.lowerBound.line {
            tailOffset += Self.offset(ofLine: line, in: tail.utf8)
        } else {
            tailOffset = source.utf8.count
        }
    }

    /// UTF-8 offset of a 1-based line from the start of `text`. Scans bytes,
    /// not Characters, because "\r\n" is a single Character.
    private static func offset(ofLine line: Int, in text: Substring.UTF8View) -> Int {
        var offset = 0
        var remaining = line - 1
        for byte in text {
            if remaining == 0 { break }
            offset += 1
            if byte == UInt8(ascii: "\n") { remaining -= 1 }
        }
        return offset
    }
}
