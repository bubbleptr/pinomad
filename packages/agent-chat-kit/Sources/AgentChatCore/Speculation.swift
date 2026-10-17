import Markdown

/// Rewrites the open tail of a stream into what its half-written syntax will
/// most likely become, as chat apps show a reply mid-stream: `**bol` reads as
/// bold, an unfinished code span as code, a link whose destination is still
/// coming as a link going nowhere yet. Lines that could still turn into
/// something else (a setext underline, a table header without its delimiter
/// row) wait until they cannot.
enum Speculation {
    static func complete(_ tail: String) -> String {
        guard let leaf = lastLeaf(of: Document(parsing: tail)), !(leaf is CodeBlock || leaf is HTMLBlock) else {
            return tail
        }
        let text = holdingBackAmbiguousLines(tail)
        guard let leaf = lastLeaf(of: Document(parsing: text)),
              leaf is Paragraph || leaf is Heading || leaf is Table,
              var line = leaf.range?.lowerBound.line
        else { return text }
        // Emphasis never crosses table cells, let alone rows.
        if leaf is Table { line = text.utf8.count { $0 == UInt8(ascii: "\n") } + 1 }
        let start = text.utf8.index(text.startIndex, offsetBy: offset(ofLine: line, in: text.utf8))
        return String(text[..<start]) + closingInlines(text[start...])
    }

    /// The innermost last block: what the next token lands in.
    private static func lastLeaf(of document: Document) -> (any BlockMarkup)? {
        var node: any BlockMarkup = document
        while let last = node.children.reversed().first(where: { $0 is BlockMarkup }) as? BlockMarkup,
              node is Document || node is BlockQuote || node is ListItemContainer || node is ListItem {
            node = last
        }
        return node is Document ? nil : node
    }

    private static func holdingBackAmbiguousLines(_ text: String) -> String {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingSuffix("\r") }
        // "-" or "==" under a paragraph would make it a heading; "- x" would not.
        if let last = lines.last, isUnderlineCandidate(last) {
            lines[lines.count - 1] = ""
        }
        // A table header shows as a paragraph of pipes until its delimiter row
        // arrives, so it waits for it.
        var end = lines.count
        if lines.last?.isEmpty == true { end -= 1 }
        var runStart = end
        while runStart > 0, lines[runStart - 1].drop(while: { $0 == " " }).hasPrefix("|") { runStart -= 1 }
        if runStart < end, !(Document(parsing: lines[runStart..<end].joined(separator: "\n")).child(at: 0) is Table) {
            lines.removeSubrange(runStart...)
            lines.append("")
        }
        if lines.count == 1, lines[0].isEmpty { return "" }
        return lines.joined(separator: "\n")
    }

    private static func isUnderlineCandidate(_ line: Substring) -> Bool {
        let marks = line.drop(while: { $0 == " " }).trimmingSuffix(" ")
        guard let first = marks.first, first == "-" || first == "=" else { return false }
        return line.prefix(while: { $0 == " " }).count <= 3 && marks.allSatisfy { $0 == first }
    }

    /// Closes the code span, link destination and emphasis left open at the
    /// end of a block's inline text.
    private static func closingInlines(_ inline: Substring) -> String {
        var chars = Array(inline)
        trimTrailingSpace(&chars)
        // A delimiter run with nothing after it yet opens nothing.
        if let run = trailingRun(chars), run.start == 0 || chars[run.start - 1].isWhitespace {
            chars.removeSubrange(run.start...)
            trimTrailingSpace(&chars)
        }

        var openers: [(mark: Character, count: Int)] = []
        var codeTicks: Int?
        var destinationStart: Int?
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if destinationStart != nil {
                if c == ")" { destinationStart = nil }
                i += 1
            } else if c == "\\" {
                i += 2
            } else if c == "`" {
                let n = runLength(chars, from: i)
                if codeTicks == nil { codeTicks = n } else if codeTicks == n { codeTicks = nil }
                i += n
            } else if codeTicks != nil {
                i += 1
            } else if c == "]", i + 1 < chars.count, chars[i + 1] == "(" {
                destinationStart = i + 2
                i += 2
            } else if c == "*" || c == "_" || c == "~" {
                let n = runLength(chars, from: i)
                let flank = Flanking(before: i > 0 ? chars[i - 1] : nil, after: i + n < chars.count ? chars[i + n] : nil)
                var remaining = n
                if flank.canClose(c) {
                    while remaining > 0, let index = openers.lastIndex(where: { $0.mark == c }) {
                        let taken = min(openers[index].count, remaining)
                        remaining -= taken
                        openers[index].count -= taken
                        // Openers inside the matched pair stay literal text.
                        openers.removeSubrange((openers[index].count == 0 ? index : index + 1)...)
                    }
                }
                if remaining > 0, flank.canOpen(c) { openers.append((c, remaining)) }
                i += n
            } else {
                i += 1
            }
        }

        var result = String(chars[..<(destinationStart ?? chars.count)])
        if destinationStart != nil { result += ")" }
        if let ticks = codeTicks { result += String(repeating: "`", count: ticks) }
        for opener in openers.reversed() { result += String(repeating: opener.mark, count: opener.count) }
        return result
    }

    private static func trimTrailingSpace(_ chars: inout [Character]) {
        while let last = chars.last, last == " " || last == "\t" { chars.removeLast() }
    }

    private static func trailingRun(_ chars: [Character]) -> (start: Int, mark: Character)? {
        guard let mark = chars.last, "*_~`".contains(mark) else { return nil }
        var start = chars.count - 1
        while start > 0, chars[start - 1] == mark { start -= 1 }
        return (start, mark)
    }

    private static func runLength(_ chars: [Character], from start: Int) -> Int {
        var end = start
        while end < chars.count, chars[end] == chars[start] { end += 1 }
        return end - start
    }

    private static func offset(ofLine line: Int, in text: String.UTF8View) -> Int {
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

/// CommonMark's left- and right-flanking rules for a delimiter run.
private struct Flanking {
    let left: Bool
    let right: Bool
    let punctuationBefore: Bool
    let punctuationAfter: Bool

    init(before: Character?, after: Character?) {
        // The start and end of the text count as whitespace.
        let spaceBefore = before?.isWhitespace ?? true
        let spaceAfter = after?.isWhitespace ?? true
        punctuationBefore = before.map { $0.isPunctuation || $0.isSymbol } ?? false
        punctuationAfter = after.map { $0.isPunctuation || $0.isSymbol } ?? false
        left = !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore)
        right = !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter)
    }

    // Underscores do not open or close inside words, as in snake_case.
    func canOpen(_ mark: Character) -> Bool {
        mark == "_" ? left && (!right || punctuationBefore) : left
    }

    func canClose(_ mark: Character) -> Bool {
        mark == "_" ? right && (!left || punctuationAfter) : right
    }
}

private extension Substring {
    func trimmingSuffix(_ character: Character) -> Substring {
        var result = self
        while result.last == character { result.removeLast() }
        return result
    }
}
