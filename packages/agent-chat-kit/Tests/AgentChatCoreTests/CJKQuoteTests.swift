@testable import AgentChatCore
import Markdown
import Testing

@Suite struct CJKQuoteTests {
    /// The paragraph's text, and the text of the runs marked as CJK quotes.
    private func inline(_ markdown: String) -> (text: String, cjk: String) {
        let paragraph = Document(parsing: markdown).child(at: 0)!
        let runs = MarkdownInline(paragraph).runs
        return (runs.map(\.text).joined(), runs.filter(\.isCJKQuote).map(\.text).joined())
    }

    // cmark's smart quotes need spaces to tell an opening quote from a
    // closing one; between Han characters both come out as closing quotes.
    @Test func quotesBetweenHanCharactersPairUp() {
        let result = inline(#"于是"组合问题"变成"特征值"。"#)
        #expect(result.text == "于是“组合问题”变成“特征值”。")
        #expect(result.cjk == "“”“”")
    }

    @Test func quotesAroundLatinTextInsideChineseAreCJK() {
        let result = inline(#"他说"hello world"。"#)
        #expect(result.text == "他说“hello world”。")
        #expect(result.cjk == "“”")
    }

    // The opening quote is a run of its own, between two emphasized ones.
    @Test func neighborsAcrossStyledRunsCount() {
        let result = inline(#"用*斜体*"*引号*"。"#)
        #expect(result.text == "用斜体“引号”。")
        #expect(result.cjk == "“”")
    }

    @Test func curlyQuotesTheModelWroteStay() {
        let result = inline("于是“组合问题”变成‘特征值’")
        #expect(result.text == "于是“组合问题”变成‘特征值’")
        #expect(result.cjk == "“”‘’")
    }

    @Test func englishQuotesStayLatin() {
        let result = inline(#"He said "hi" and left, 然后走了。"#)
        #expect(result.text == "He said “hi” and left, 然后走了。")
        #expect(result.cjk.isEmpty)
    }

    @Test func codeIsLeftAlone() {
        let result = inline(#"用`"x"`表示"#)
        #expect(result.text == #"用"x"表示"#)
        #expect(result.cjk.isEmpty)
    }
}
