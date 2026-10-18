/// CommonMark accepts LF, CRLF and CR as line endings. The stream works in
/// UTF-8 offsets, so these scanners look at bytes: in Characters "\r\n" is
/// one Character and byte offsets cannot be recovered from it.
enum MarkdownLines {
    private static let carriageReturn = UInt8(ascii: "\r")
    private static let lineFeed = UInt8(ascii: "\n")

    /// Number of line endings in `text`, counting CRLF once.
    static func lineBreakCount(in text: some Sequence<UInt8>) -> Int {
        var count = 0
        var previousWasCarriageReturn = false
        for byte in text {
            if byte == carriageReturn {
                count += 1
                previousWasCarriageReturn = true
            } else if byte == lineFeed {
                if !previousWasCarriageReturn { count += 1 }
                previousWasCarriageReturn = false
            } else {
                previousWasCarriageReturn = false
            }
        }
        return count
    }

    /// UTF-8 offset of a 1-based line from the start of `text`. A line past
    /// the end clamps to the end.
    static func offset(ofLine line: Int, in text: some Collection<UInt8>) -> Int {
        guard line > 1 else { return 0 }
        var offset = 0
        var remaining = line - 1
        var index = text.startIndex
        while index < text.endIndex, remaining > 0 {
            let byte = text[index]
            if byte == carriageReturn {
                offset += 1
                index = text.index(after: index)
                if index < text.endIndex, text[index] == lineFeed {
                    offset += 1
                    index = text.index(after: index)
                }
                remaining -= 1
            } else if byte == lineFeed {
                offset += 1
                index = text.index(after: index)
                remaining -= 1
            } else {
                offset += 1
                index = text.index(after: index)
            }
        }
        return offset
    }

    /// Lines split at any line ending, without the endings themselves.
    static func lines(of text: String) -> [Substring] {
        var lines: [Substring] = []
        var start = text.startIndex
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            if character == "\r" || character == "\n" {
                lines.append(text[start..<index])
                let next = text.index(after: index)
                if character == "\r", next < text.endIndex, text[next] == "\n" {
                    index = next
                }
                index = text.index(after: index)
                start = index
            } else {
                index = text.index(after: index)
            }
        }
        lines.append(text[start...])
        return lines
    }
}
