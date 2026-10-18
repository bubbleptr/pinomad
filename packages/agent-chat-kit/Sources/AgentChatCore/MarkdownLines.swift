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
    /// Scans bytes because "\r\n" is one Character and would never match a
    /// Character comparison against "\r" or "\n".
    static func lines(of text: String) -> [Substring] {
        var lines: [Substring] = []
        let bytes = text.utf8
        var start = bytes.startIndex
        var index = start
        while index < bytes.endIndex {
            let byte = bytes[index]
            if byte == carriageReturn || byte == lineFeed {
                lines.append(text[start..<index])
                var next = bytes.index(after: index)
                if byte == carriageReturn, next < bytes.endIndex, bytes[next] == lineFeed {
                    next = bytes.index(after: next)
                }
                start = next
                index = next
            } else {
                index = bytes.index(after: index)
            }
        }
        lines.append(text[start...])
        return lines
    }
}
