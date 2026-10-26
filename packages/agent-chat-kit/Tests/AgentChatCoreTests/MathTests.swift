@testable import AgentChatCore
import Foundation
import Testing

@Suite struct MathTests {
    private func blocks(_ markdown: String) -> [MarkdownContent] {
        var stream = MarkdownStream()
        stream.append(markdown)
        stream.finish()
        return stream.blocks.map(\.content)
    }

    private func runs(_ markdown: String) -> [MarkdownInlineRun] {
        guard case let .paragraph(inline)? = blocks(markdown).first else { return [] }
        return inline.runs
    }

    /// Text runs as written, math runs as `[latex]`.
    private func inline(_ markdown: String) -> String {
        runs(markdown).map { $0.math == nil ? $0.text : "[\($0.text)]" }.joined()
    }

    // cmark would eat `\{`, `\;` and `\\` as escapes and `_..._` as
    // emphasis; math keeps its source exactly.
    @Test func inlineMathKeepsItsSource() {
        #expect(inline(#"关键恒等式：$L = BB^\top$。"#) == #"关键恒等式：[L = BB^\top]。"#)
        #expect(inline(#"set $\{x_i\;|\;i\in E\}$ here"#) == #"set [\{x_i\;|\;i\in E\}] here"#)
        #expect(inline(#"both $a_1$ and $b_1$"#) == "both [a_1] and [b_1]")
        #expect(inline(#"paren \(x^2\) form"#) == "paren [x^2] form")
    }

    @Test(arguments: [
        "costs $5 and $10 today",
        "from $5 to $10",
        "a lone $ sign",
        "spaced $ x $ is not math",
    ])
    func dollarsThatAreNotMathStayText(markdown: String) {
        #expect(runs(markdown).allSatisfy { $0.math == nil })
        #expect(inline(markdown) == markdown)
    }

    @Test func codeKeepsItsDollars() {
        #expect(inline("run `echo $HOME$` now") == "run echo $HOME$ now")
        #expect(blocks("```sh\necho $a$\n```") == [.codeBlock(language: "sh", code: "echo $a$\n")])
        #expect(inline(#"price \$5, math $x$"#) == "price $5, math [x]")
    }

    // Code is whatever cmark says is code: indented blocks, fences in a
    // quote, and indentation measured from a list item's content.
    @Test func everyKindOfCodeBlockKeepsItsDollars() {
        #expect(blocks("    echo $HOME/$USER\n") == [.codeBlock(language: nil, code: "echo $HOME/$USER\n")])
        #expect(PlainText.of(markdown: "    echo $HOME/$USER\n") == "echo $HOME/$USER")
        #expect(blocks("> ```sh\n> echo $a$\n> ```") == [.blockQuote([.codeBlock(language: "sh", code: "echo $a$\n")])])
        guard case let .list(list)? = blocks("- x\n\n      echo $a/$b\n").first else {
            Issue.record("not a list")
            return
        }
        #expect(list.items.first?.blocks.last == .codeBlock(language: nil, code: "echo $a/$b\n"))
    }

    // Four spaces in a list item are only two past its content: still prose.
    @Test func indentedProseInAListItemIsStillMath() {
        guard case let .list(list)? = blocks("- x\n\n    then $a_1$\n").first,
              case let .paragraph(text)? = list.items.first?.blocks.last
        else {
            Issue.record("not a list with a paragraph")
            return
        }
        #expect(text.runs.contains { $0.math == .inline && $0.text == "a_1" })
    }

    // A dollar in a URL is part of the address, not a formula.
    @Test func linkDestinationsKeepTheirDollars() {
        let url = "https://example.com/$release$/file"
        #expect(runs("[下载](\(url))").map(\.link) == [URL(string: url)])
        #expect(runs("![图](\(url) \"t\")").allSatisfy { $0.math == nil })
        #expect(MathSyntax.protect("[r]: \(url)\n") == "[r]: \(url)\n")
        // The label is text, and its math still counts.
        #expect(runs("[$x$](https://example.com)").contains { $0.math == .inline && $0.link != nil })
    }

    // A formula on its own lines may hold what reads as Markdown until it
    // closes; the blocks it spans stay open until then.
    @Test func unclosedDisplayMathKeepsItsBlocksOpen() {
        var stream = MarkdownStream()
        stream.append("$$\na\n- b\n")
        stream.append("$$")
        stream.finish()
        #expect(stream.blocks.map(\.content) == [.math("a\n- b")])
        #expect(stream.blocks.map(\.content) == blocks("$$\na\n- b\n$$"))
    }

    @Test func displayMathIsABlock() {
        let source = """
        Before:

        $$
        x^\\top L x=\\sum_{(i,j)\\in E}(x_i-x_j)^2
        $$

        After.
        """
        #expect(blocks(source).count == 3)
        #expect(blocks(source)[1] == .math(#"x^\top L x=\sum_{(i,j)\in E}(x_i-x_j)^2"#))
        #expect(blocks(#"$$\frac{1}{48}$$"#) == [.math(#"\frac{1}{48}"#)])
        #expect(blocks("\\[\na+b\n\\]") == [.math("a+b")])
        #expect(blocks("```math\na+b\n```") == [.math("a+b")])
    }

    // A display formula in a list item keeps the item's indentation.
    @Test func displayMathInsideAListItem() {
        let source = "- energy:\n\n  $$\n  x^2\n  $$\n- next"
        guard case let .list(list)? = blocks(source).first else {
            Issue.record("not a list")
            return
        }
        #expect(list.items.first?.blocks.last == .math("x^2"))
    }

    // An unfinished formula streams as text, and turns into math when it closes.
    @Test func unclosedMathStaysText() {
        var stream = MarkdownStream()
        stream.append(#"so $x^\top"#)
        guard case let .paragraph(open)? = stream.blocks.first?.content else { return }
        #expect(open.runs.allSatisfy { $0.math == nil })
        stream.append(#" L$ done"#)
        stream.finish()
        guard case let .paragraph(closed)? = stream.blocks.first?.content else { return }
        #expect(closed.runs.contains { $0.math == .inline && $0.text == #"x^\top L"# })
    }

    @Test func copyingKeepsTheSource() {
        #expect(PlainText.of(markdown: "is $a_1\\;b$ and\n\n$$\nx\\\\y\n$$") == "is $a_1\\;b$ and\n\n$$x\\\\y$$")
    }

    // Latin Modern has no CJK glyphs: top-level CJK `\text{}` is set as text.
    @Test func cjkTextSplitsOutOfTheFormula() {
        let latex = #"\text{魔方状态}\;\to\;\text{群 }G\le S_{54}"#
        #expect(MathLayout.segments(of: latex) == [
            .text("魔方状态"), .latex(#"\;\to\;"#), .text("群 "), .latex(#"G\le S_{54}"#),
        ])
        #expect(MathLayout.segments(of: #"\text{if } x>0"#) == [.latex(#"\text{if } x>0"#)])
    }

    @Test func commandsTheRendererLacksAreRewritten() {
        #expect(MathLayout.segments(of: #"\operatorname{im}\partial"#) == [.latex(#"\mathrm{im}\partial"#)])
        #expect(MathLayout.segments(of: #"a\equiv 0 \pmod 3"#) == [.latex(#"a\equiv 0 \;(\mathrm{mod}\;3)"#)])
        #expect(MathLayout.segments(of: #"a\pmod{n}"#) == [.latex(#"a\;(\mathrm{mod}\;n)"#)])
    }
}
