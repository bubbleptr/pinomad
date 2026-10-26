/// TeX math in a reply, hidden from Markdown before it is parsed: cmark
/// would read `\{` and `\;` as escapes and `_i ... _j` as emphasis.
///
/// `$…$` and `\(…\)` become code spans whose text starts with
/// `inlineMark`, `$$…$$` and `\[…\]` within a paragraph code spans
/// starting with `displayMark`. A `$$` or `\[` on a line of its own,
/// closed by one on a later line, becomes a fenced ```` ```math ```` block,
/// the way GitHub writes display math. Code spans and fenced code keep
/// their dollars.
///
/// Every line break stays where it was: the stream maps the parser's line
/// numbers back to offsets in the text as written.
enum MathSyntax {
    static let inlineMark: Character = "\u{E000}"
    static let displayMark: Character = "\u{E001}"
    static let fenceLanguage = "math"

    static func protect(_ source: String) -> String {
        guard source.contains("$") || source.contains("\\(") || source.contains("\\[") else { return source }
        let lines = linesKeepingEndings(source)
        var output = ""
        var paragraph = ""
        var fence: (mark: Character, count: Int)?
        var index = 0

        func flushParagraph() {
            output += protectInline(paragraph)
            paragraph = ""
        }

        while index < lines.count {
            let line = lines[index]
            let body = line.drop { $0 == " " || $0 == "\t" }
            if let open = fence {
                output += line
                if closesFence(body, open) { fence = nil }
                index += 1
                continue
            }
            if let opened = opensFence(body) {
                flushParagraph()
                fence = opened
                output += line
                index += 1
                continue
            }
            let token = trimmed(line)
            if token == "$$" || token == "\\[",
               let close = lines[(index + 1)...].firstIndex(where: { trimmed($0) == (token == "$$" ? "$$" : "\\]") }) {
                flushParagraph()
                output += replacingToken(in: line, with: "```" + fenceLanguage)
                for content in lines[(index + 1)..<close] { output += content }
                output += replacingToken(in: lines[close], with: "```")
                index = close + 1
                continue
            }
            if token.isEmpty {
                flushParagraph()
                output += line
            } else {
                paragraph += line
            }
            index += 1
        }
        flushParagraph()
        return output
    }

    /// Math and code spans within one run of text lines. Inline math stays
    /// on its line; `$$…$$` may cross lines, but not a blank one.
    private static func protectInline(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        let chars = Array(text)
        var output = ""
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\", i + 1 < chars.count {
                let next = chars[i + 1]
                if next == "(" || next == "[" {
                    let closer: [Character] = next == "(" ? ["\\", ")"] : ["\\", "]"]
                    if let end = find(closer, in: chars, from: i + 2, sameLine: next == "("),
                       !isBlank(chars[(i + 2)..<end]) {
                        output += codeSpan(next == "(" ? inlineMark : displayMark, String(chars[(i + 2)..<end]))
                        i = end + 2
                        continue
                    }
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
            if c == "$" {
                if i + 1 < chars.count, chars[i + 1] == "$" {
                    if let end = find(["$", "$"], in: chars, from: i + 2, sameLine: false),
                       !isBlank(chars[(i + 2)..<end]) {
                        output += codeSpan(displayMark, String(chars[(i + 2)..<end]))
                        i = end + 2
                    } else {
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
        return output
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

    private static func opensFence(_ body: Substring) -> (mark: Character, count: Int)? {
        guard let mark = body.first, mark == "`" || mark == "~" else { return nil }
        let count = body.prefix { $0 == mark }.count
        guard count >= 3 else { return nil }
        if mark == "`", body.dropFirst(count).contains("`") { return nil }
        return (mark, count)
    }

    private static func closesFence(_ body: Substring, _ fence: (mark: Character, count: Int)) -> Bool {
        let count = body.prefix { $0 == fence.mark }.count
        return count >= fence.count && body.dropFirst(count).allSatisfy(\.isWhitespace)
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

    private static func linesKeepingEndings(_ text: String) -> [Substring] {
        var lines: [Substring] = []
        var start = text.startIndex
        var index = start
        while index < text.endIndex {
            let next = text.index(after: index)
            if text[index].isNewline {
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
