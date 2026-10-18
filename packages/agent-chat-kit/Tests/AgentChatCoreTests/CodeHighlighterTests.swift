import AgentChatCore
import Testing

@Suite struct CodeHighlighterTests {
    /// The kind of each listed span of `code`, in order of appearance.
    private func kinds(_ code: String, _ language: String?, _ spans: [String]) -> [CodeToken.Kind?] {
        let tokens = CodeHighlighter.tokens(in: code, language: language)
        var searchFrom = code.startIndex
        return spans.map { span in
            guard let range = code.range(of: span, range: searchFrom..<code.endIndex) else { return nil }
            searchFrom = range.upperBound
            return tokens.first { $0.range == range }?.kind
        }
    }

    @Test func swiftKeywordsStringsCommentsAndTypes() {
        let code = """
        // Write atomically
        let tmp = url.appendingPathExtension("tmp")
        try FileManager.default.replaceItemAt(url, withItemAt: tmp, retries: 3)
        """
        #expect(kinds(code, "swift", ["// Write atomically", "let", "\"tmp\"", "try", "FileManager", "3"])
            == [.comment, .keyword, .string, .keyword, .type, .number])
    }

    // Keywords and comments inside a string are part of the string.
    @Test func stringsSwallowWhatLooksLikeCode() {
        let code = #"print("let // not a comment \" still string") // comment"#
        #expect(kinds(code, "swift", [#""let // not a comment \" still string""#, "// comment"]) == [.string, .comment])
    }

    @Test func blockCommentsSpanLines() {
        let code = "/* one\nlet two */ let three"
        #expect(kinds(code, "ts", ["/* one\nlet two */", "let"]) == [.comment, .keyword])
    }

    // A code block still streaming in has an unclosed string or comment.
    @Test func unclosedStringRunsToTheEndOfTheLine() {
        let code = "let s = \"half\nlet t = 1"
        #expect(kinds(code, "swift", ["\"half", "let", "1"]) == [.string, .keyword, .number])
    }

    @Test func pythonHashCommentsAndTripleQuotes() {
        let code = "def f():\n    \"\"\"Doc\nstring\"\"\"\n    return None  # done"
        #expect(kinds(code, "python", ["def", "\"\"\"Doc\nstring\"\"\"", "return", "None", "# done"])
            == [.keyword, .string, .keyword, .keyword, .comment])
    }

    @Test func shellCommentsAndVariables() {
        let code = "export PATH=\"$HOME/bin\" # add bin\nif [ -f x ]; then echo ok; fi"
        #expect(kinds(code, "bash", ["export", "\"$HOME/bin\"", "# add bin", "if", "then", "fi"])
            == [.keyword, .string, .comment, .keyword, .keyword, .keyword])
    }

    // Python starts a comment at any # outside a string, with no space needed.
    @Test func pythonCommentsNeedNoLeadingWhitespace() {
        let code = "x = 1# return False"
        #expect(kinds(code, "python", ["1", "# return False"]) == [.number, .comment])
        #expect(CodeHighlighter.tokens(in: code, language: "python").contains { $0.kind == .keyword } == false)
    }

    // Shell keeps the word-start rule: a # inside a word is not a comment.
    @Test func shellCommentsStillNeedAWordStart() {
        #expect(CodeHighlighter.tokens(in: "echo foo#not-a-comment", language: "bash").contains { $0.kind == .comment } == false)
    }

    @Test func diffLines() {
        let code = "@@ -1,2 +1,2 @@\n-try data.write(to: url)\n+try data.write(to: tmp)\n context"
        #expect(kinds(code, "diff", ["@@ -1,2 +1,2 @@", "-try data.write(to: url)", "+try data.write(to: tmp)"])
            == [.meta, .deleted, .inserted])
    }

    @Test func jsonKeysAreNotPlainStrings() {
        let code = #"{"name": "pinomad", "count": 2, "ok": true}"#
        #expect(kinds(code, "json", [#""name""#, #""pinomad""#, "2", "true"]) == [.key, .string, .number, .keyword])
    }

    @Test func unknownLanguagesStayPlain() {
        #expect(CodeHighlighter.tokens(in: "let x = \"y\"", language: "brainfuck").isEmpty)
        #expect(CodeHighlighter.tokens(in: "let x = \"y\"", language: nil).isEmpty)
    }
}
