import Markdown

/// TeX math in a reply, hidden from Markdown before it is parsed: cmark
/// would read `\{` and `\;` as escapes and `_i ... _j` as emphasis.
///
/// `$…$` and `\(…\)` become code spans whose text starts with
/// `inlineMark`, `$$…$$` and `\[…\]` within a paragraph code spans
/// starting with `displayMark`. A `$$` or `\[` on a line of its own,
/// closed by one on a later line, becomes a fenced ```` ```math ```` block,
/// the way GitHub writes display math. Math is only looked for in the
/// lines cmark reads as paragraphs, headings and tables: code, HTML and
/// link reference definitions keep their dollars, as do code spans and
/// link destinations.
///
/// Every line break stays where it was: the stream maps the parser's line
/// numbers back to offsets in the text as written.
enum MathSyntax {
    static let inlineMark: Character = "\u{E000}"
    static let displayMark: Character = "\u{E001}"
    static let fenceLanguage = "math"

    static func protect(_ source: String) -> String {
        protecting(source).text
    }

    /// `pendingLine` is the 1-based line of the first formula that has not
    /// closed but still could: until it does, the Markdown it spans may be
    /// read as other blocks, so none of them may close.
    static func protecting(_ source: String) -> (text: String, pendingLine: Int?) {
        guard source.contains("$") || source.contains("\\(") || source.contains("\\[") else { return (source, nil) }
        let lines = linesKeepingEndings(source)
        let prose = proseLines(source)
        var output = ""
        var paragraph = ""
        var paragraphStart = 0
        var pendingLine: Int?
        var index = 0

        func flushParagraph(last: Bool = false) {
            let (text, open) = protectInline(paragraph)
            output += text
            if last, pendingLine == nil, let open {
                let breaks = paragraph.prefix(open).count { isLineEnding($0) }
                pendingLine = paragraphStart + breaks + 1
            }
            paragraph = ""
        }

        while index < lines.count {
            let line = lines[index]
            guard prose.contains(index) else {
                flushParagraph()
                output += line
                index += 1
                continue
            }
            let token = trimmed(line)
            if token == "$$" || token == "\\[" {
                let closer = token == "$$" ? "$$" : "\\]"
                if let close = lines.indices.dropFirst(index + 1).first(where: { prose.contains($0) && trimmed(lines[$0]) == closer }) {
                    flushParagraph()
                    output += replacingToken(in: line, with: "```" + fenceLanguage)
                    for content in lines[(index + 1)..<close] { output += content }
                    output += replacingToken(in: lines[close], with: "```")
                    index = close + 1
                    continue
                }
                if pendingLine == nil { pendingLine = index + 1 }
            }
            if paragraph.isEmpty { paragraphStart = index }
            paragraph += line
            index += 1
        }
        flushParagraph(last: true)
        return (output, pendingLine)
    }

    /// Indices of the lines cmark parses as paragraphs, headings or tables,
    /// at any depth: what is left is code, HTML, link reference definitions,
    /// thematic breaks and blank lines. Blocks are settled before inlines
    /// are parsed, so the math inside the text cannot change which lines
    /// these are.
    private static func proseLines(_ source: String) -> Set<Int> {
        var lines = Set<Int>()
        func collect(_ markup: any Markup) {
            switch markup {
            case is Paragraph, is Heading, is Markdown.Table:
                if let range = markup.range {
                    lines.formUnion((range.lowerBound.line - 1)...(range.upperBound.line - 1))
                }
            default:
                for child in markup.children { collect(child) }
            }
        }
        collect(Document(parsing: source))
        return lines
    }

    /// Math and code spans within one run of text lines. Inline math stays
    /// on its line; `$$…$$` may cross lines, but not a blank one. `open` is
    /// where a `$$` or `\[` starts that the text ends before closing.
    private static func protectInline(_ text: String) -> (text: String, open: Int?) {
        guard !text.isEmpty else { return (text, nil) }
        let chars = Array(text)
        var output = ""
        var open: Int?
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\", i + 1 < chars.count {
                let next = chars[i + 1]
                if next == "(" || next == "[" {
                    let closer: [Character] = next == "(" ? ["\\", ")"] : ["\\", "]"]
                    let end = find(closer, in: chars, from: i + 2, sameLine: next == "(")
                    if let end, !isBlank(chars[(i + 2)..<end]) {
                        output += codeSpan(next == "(" ? inlineMark : displayMark, String(chars[(i + 2)..<end]))
                        i = end + 2
                        continue
                    }
                    if end == nil, next == "[", open == nil { open = i }
                }
                // `\$` and `\\` are escapes: their second character is not syntax.
                output.append(c)
                output.append(next)
                i += 2
                continue
            }
            if c == "`" {
                let run = runLength(of: "`", in: chars, at: i)
                if let end = closingTicks(run, in: chars, from: i + run) {
                    output += String(chars[i..<(end + run)])
                    i = end + run
                } else {
                    output += String(repeating: "`", count: run)
                    i += run
                }
                continue
            }
            if c == "]", i + 1 < chars.count, chars[i + 1] == "(",
               let end = linkTailEnd(in: chars, from: i + 2) {
                output += String(chars[i...end])
                i = end + 1
                continue
            }
            if c == "$" {
                if i + 1 < chars.count, chars[i + 1] == "$" {
                    let end = find(["$", "$"], in: chars, from: i + 2, sameLine: false)
                    if let end, !isBlank(chars[(i + 2)..<end]) {
                        output += codeSpan(displayMark, String(chars[(i + 2)..<end]))
                        i = end + 2
                    } else {
                        if end == nil, open == nil { open = i }
                        output += "$$"
                        i += 2
                    }
                    continue
                }
                if let end = closingDollar(in: chars, from: i + 1) {
                    output += codeSpan(inlineMark, String(chars[(i + 1)..<end]))
                    i = end + 1
                    continue
                }
            }
            output.append(c)
            i += 1
        }
        return (output, open)
    }

    /// Where the `(destination "title")` after a link's `]` ends, at its
    /// `)`; nil if what follows is not one. The destination is part of the
    /// address, not text, so its dollars stay as written.
    private static func linkTailEnd(in chars: [Character], from start: Int) -> Int? {
        var j = start
        func skipSpace() { while j < chars.count, chars[j].isWhitespace { j += 1 } }
        skipSpace()
        if j < chars.count, chars[j] == "<" {
            j += 1
            while j < chars.count, chars[j] != ">" {
                if chars[j] == "<" || isLineEnding(chars[j]) { return nil }
                j += chars[j] == "\\" ? 2 : 1
            }
            guard j < chars.count else { return nil }
            j += 1
        } else {
            var depth = 0
            while j < chars.count, !chars[j].isWhitespace, !(chars[j] == ")" && depth == 0) {
                if chars[j] == "(" { depth += 1 }
                if chars[j] == ")" { depth -= 1 }
                j += chars[j] == "\\" ? 2 : 1
            }
            guard depth == 0 else { return nil }
        }
        let beforeTitle = j
        skipSpace()
        let titleClosers: [Character: Character] = ["\"": "\"", "'": "'", "(": ")"]
        if j > beforeTitle, j < chars.count, let quote = titleClosers[chars[j]] {
            j += 1
            while j < chars.count, chars[j] != quote {
                j += chars[j] == "\\" ? 2 : 1
            }
            guard j < chars.count else { return nil }
            j += 1
            skipSpace()
        }
        return j < chars.count && chars[j] == ")" ? j : nil
    }

    /// Pandoc's rule: the opening `$` has a non-space after it, the closing
    /// one a non-space before it and no digit after it, so "$5 and $10"
    /// stays money.
    private static func closingDollar(in chars: [Character], from start: Int) -> Int? {
        guard start < chars.count, !chars[start].isWhitespace else { return nil }
        var j = start
        while j < chars.count, !chars[j].isNewline {
            if chars[j] == "\\" {
                j += 2
                continue
            }
            if chars[j] == "$" {
                let after = j + 1 < chars.count ? chars[j + 1] : nil
                if j > start, !chars[j - 1].isWhitespace, after.map({ !$0.isNumber }) ?? true {
                    return j
                }
                return nil
            }
            j += 1
        }
        return nil
    }

    /// Where `closer` starts, skipping escapes; never past a blank line.
    private static func find(_ closer: [Character], in chars: [Character], from start: Int, sameLine: Bool) -> Int? {
        var j = start
        while j + closer.count <= chars.count {
            if chars[j].isNewline {
                if sameLine { return nil }
                var k = j + 1
                while k < chars.count, chars[k] == " " || chars[k] == "\t" { k += 1 }
                if k < chars.count, chars[k].isNewline { return nil }
            }
            if Array(chars[j..<(j + closer.count)]) == closer { return j }
            if chars[j] == "\\", closer.first != "\\" {
                j += 2
                continue
            }
            j += 1
        }
        return nil
    }

    /// A backtick run of exactly `count`, as CommonMark closes a code span.
    private static func closingTicks(_ count: Int, in chars: [Character], from start: Int) -> Int? {
        var j = start
        while j < chars.count {
            if chars[j] == "`" {
                let run = runLength(of: "`", in: chars, at: j)
                if run == count { return j }
                j += run
            } else {
                j += 1
            }
        }
        return nil
    }

    private static func runLength(of mark: Character, in chars: [Character], at start: Int) -> Int {
        var end = start
        while end < chars.count, chars[end] == mark { end += 1 }
        return end - start
    }

    private static func isBlank(_ chars: ArraySlice<Character>) -> Bool {
        chars.allSatisfy(\.isWhitespace)
    }

    /// A code span cmark leaves verbatim, its text tagged with `mark`.
    private static func codeSpan(_ mark: Character, _ latex: String) -> String {
        var longest = 0
        var current = 0
        for c in latex {
            current = c == "`" ? current + 1 : 0
            longest = max(longest, current)
        }
        let ticks = String(repeating: "`", count: longest + 1)
        // A trailing backtick would merge with the closing run.
        let tail = latex.last == "`" ? " " : ""
        return ticks + String(mark) + latex + tail + ticks
    }

    /// The line with its `$$`, `\[` or `\]` swapped for a fence, keeping its
    /// indentation and line ending.
    private static func replacingToken(in line: Substring, with fence: String) -> String {
        let indent = line.prefix { $0 == " " || $0 == "\t" }
        let ending = line.last?.isNewline == true ? String(line.last!) : ""
        return indent + fence + ending
    }

    private static func trimmed(_ line: Substring) -> Substring {
        var result = line.drop { $0 == " " || $0 == "\t" }
        while let last = result.last, last.isWhitespace { result.removeLast() }
        return result
    }

    /// cmark ends lines at LF, CR and CRLF only; Swift's `isNewline` also
    /// takes U+2028 and form feeds, which would shift every line number.
    private static func isLineEnding(_ c: Character) -> Bool {
        c == "\n" || c == "\r" || c == "\r\n"
    }

    private static func linesKeepingEndings(_ text: String) -> [Substring] {
        var lines: [Substring] = []
        var start = text.startIndex
        var index = start
        while index < text.endIndex {
            let next = text.index(after: index)
            if isLineEnding(text[index]) {
                lines.append(text[start..<next])
                start = next
            }
            index = next
        }
        if start < text.endIndex { lines.append(text[start...]) }
        return lines
    }
}

/// A piece of a formula as it is drawn.
public enum MathSegment: Sendable, Equatable {
    case latex(String)
    /// Prose inside the formula, set in the text font.
    case text(String)
}

public enum MathLayout {
    /// The formula in drawable pieces: the math fonts have no CJK glyphs,
    /// so a top-level `\text{}` holding anything beyond ASCII comes out as
    /// text between the formula's parts. Commands the renderer lacks are
    /// rewritten to ones it has.
    public static func segments(of latex: String) -> [MathSegment] {
        let source = rewritten(latex)
        let chars = Array(source)
        var segments: [MathSegment] = []
        var current = ""
        var depth = 0
        var i = 0
        let textCommand = Array("\\text{")

        func flush() {
            if !current.allSatisfy(\.isWhitespace) { segments.append(.latex(current)) }
            current = ""
        }

        while i < chars.count {
            let c = chars[i]
            if depth == 0, c == "\\", chars[i...].starts(with: textCommand),
               let end = matchingBrace(in: chars, from: i + textCommand.count) {
                let content = String(chars[(i + textCommand.count)..<end])
                if !content.allSatisfy(\.isASCII) {
                    flush()
                    segments.append(.text(content))
                    i = end + 1
                    continue
                }
            }
            if c == "\\", i + 1 < chars.count {
                current.append(c)
                current.append(chars[i + 1])
                i += 2
                continue
            }
            if c == "{" { depth += 1 }
            if c == "}" { depth = max(depth - 1, 0) }
            current.append(c)
            i += 1
        }
        flush()
        return segments
    }

    private static func matchingBrace(in chars: [Character], from start: Int) -> Int? {
        var depth = 1
        var j = start
        while j < chars.count {
            switch chars[j] {
            case "\\": j += 1
            case "{": depth += 1
            case "}":
                depth -= 1
                if depth == 0 { return j }
            default: break
            }
            j += 1
        }
        return nil
    }

    private static func rewritten(_ latex: String) -> String {
        latex
            .replacing(/\\operatorname\*?\{/, with: "\\mathrm{")
            .replacing(/\\pmod\s*\{([^{}]*)\}/) { "\\;(\\mathrm{mod}\\;\($0.1))" }
            .replacing(/\\pmod\s*(\\[A-Za-z]+|[^\s{])/) { "\\;(\\mathrm{mod}\\;\($0.1))" }
    }
}
