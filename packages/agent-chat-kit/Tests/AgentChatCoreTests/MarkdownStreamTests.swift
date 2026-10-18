import AgentChatCore
import Markdown
import Testing

@Suite struct MarkdownStreamTests {
    @Test func paragraphStaysOpenUntilFinish() {
        var stream = MarkdownStream()
        stream.append("Hello, ")
        stream.append("world")

        #expect(stream.blocks.map(\.isClosed) == [false])
        #expect(stream.blocks.first?.markup.format() == "Hello, world")

        stream.finish()
        #expect(stream.blocks.map(\.isClosed) == [true])
    }

    // Views key their work on this: a closed block is never parsed or laid out again.
    @Test func closedBlocksAreNotParsedAgain() throws {
        var stream = MarkdownStream()
        stream.append("First paragraph.\n\nSecond paragraph,\nstill")
        let first = try #require(stream.blocks.first)
        #expect(first.isClosed)

        stream.append(" streaming.")
        #expect(stream.blocks.first?.markup.isIdentical(to: first.markup) == true)
        stream.finish()
        #expect(stream.blocks.first?.markup.isIdentical(to: first.markup) == true)
    }

    // The tail shows what its syntax will most likely become: each partial
    // text renders as the hand-completed one parses.
    @Test(arguments: [
        ("This is **bol", "This is **bol**"),
        ("This is *ital", "This is *ital*"),
        ("This is ~~gon", "This is ~~gon~~"),
        ("**bold *both", "**bold *both***"),
        ("Keep **bold ", "Keep **bold**"),
        ("Say **", "Say"),
        ("Run `npm te", "Run `npm te`"),
        ("Run `a **b", "Run `a **b`"),
        ("snake_case_na", "snake_case_na"),
        ("2 * 3 = 6", "2 * 3 = 6"),
        ("See [the docs](https://ex", "See [the docs]()"),
        ("- one\n- **tw", "- one\n- **tw**"),
        ("# Head **in", "# Head **in**"),
        ("```swift\nlet x = 1", "```swift\nlet x = 1\n```"),
        ("Title\n-", "Title"),
        ("Title\n==", "Title"),
        ("Intro\n\n| a | b |\n", "Intro"),
        ("Intro\n\n| a | b |\n| --- | -", "Intro\n\n| a | b |\n| --- | --- |"),
        ("| a | b |\n| --- | --- |\n| **x", "| a | b |\n| --- | --- |\n| **x** |"),
    ])
    func tailShowsWhatItWillBecome(partial: String, completed: String) {
        var stream = MarkdownStream()
        stream.append(partial)
        #expect(stream.blocks.map { tree(of: $0.markup) } == trees(parsing: completed))
    }

    // A first chunk of only spaces can still become an indented code block.
    @Test func leadingWhitespaceSurvivesUntilABlockStarts() {
        var stream = MarkdownStream()
        stream.append("    ")
        stream.append("print(1)\n")
        stream.finish()

        var whole = MarkdownStream()
        whole.append("    print(1)\n")
        whole.finish()

        #expect(stream.blocks.map { tree(of: $0.markup) } == whole.blocks.map { tree(of: $0.markup) })
        #expect(stream.blocks.first?.markup is CodeBlock)
    }

    // cmark treats LF, CRLF and CR alike; line offsets must too.
    @Test(arguments: ["\n", "\r\n", "\r"])
    func lineEndingsOfEveryKind(lineEnding: String) {
        let text = ["A", "B", "C"].joined(separator: lineEnding + lineEnding)
        var stream = MarkdownStream()
        stream.append(text)
        stream.finish()

        #expect(stream.blocks.map { tree(of: $0.markup) } == trees(parsing: text))
    }

    @Test(arguments: Fixtures.replies.indices, [1, 3, 7, 0])
    func chunkingNeverChangesTheResult(reply: Int, seed: UInt64) {
        let text = Fixtures.replies[reply]
        var stream = MarkdownStream()
        var closed: [Int: String] = [:]

        for chunk in chunks(of: text, seed: seed) {
            stream.append(chunk)
            for block in stream.blocks where block.isClosed {
                let tree = tree(of: block.markup)
                if let earlier = closed[block.id] {
                    #expect(tree == earlier, "closed block \(block.id) changed")
                } else {
                    closed[block.id] = tree
                }
            }
            let open = stream.blocks.drop { $0.isClosed }
            #expect(open.allSatisfy { !$0.isClosed } && open.count <= 2, "open blocks are a short tail")
        }
        stream.finish()

        let whole = trees(parsing: text)
        #expect(stream.blocks.map { tree(of: $0.markup) } == whole)
        #expect(stream.blocks.map(\.id) == Array(whole.indices))
        for (id, tree) in closed {
            #expect(whole[id] == tree, "block \(id) changed after it closed")
        }
    }
}

/// A block's structure regardless of where it sits among its siblings.
private func tree(of markup: any Markup) -> String {
    markup.detachedFromParent.debugDescription()
}

private func trees(parsing text: String) -> [String] {
    Document(parsing: text).blockChildren.map { tree(of: $0) }
}

/// Splits text into chunks of 1–8 characters; seed 0 means one character at a time.
private func chunks(of text: String, seed: UInt64) -> [String] {
    var state = seed
    var result: [String] = []
    var rest = Substring(text)
    while !rest.isEmpty {
        var size = 1
        if seed != 0 {
            // SplitMix64: a deterministic generator, so a failure replays.
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            size = Int((z ^ (z >> 31)) % 8) + 1
        }
        result.append(String(rest.prefix(size)))
        rest = rest.dropFirst(size)
    }
    return result
}
