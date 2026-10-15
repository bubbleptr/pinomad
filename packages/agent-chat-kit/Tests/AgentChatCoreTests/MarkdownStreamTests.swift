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

    @Test(arguments: Fixtures.replies.indices, [1, 3, 7, 0])
    func chunkingNeverChangesTheResult(reply: Int, seed: UInt64) {
        let text = Fixtures.replies[reply]
        var stream = MarkdownStream()
        var closed: [Int: String] = [:]

        for chunk in chunks(of: text, seed: seed) {
            stream.append(chunk)
            for block in stream.blocks where block.isClosed {
                let tree = block.markup.debugDescription()
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

        let whole = Document(parsing: text).blockChildren.map { $0.debugDescription() } as [String]
        #expect(stream.blocks.map { $0.markup.debugDescription() } == whole)
        #expect(stream.blocks.map(\.id) == Array(whole.indices))
        for (id, tree) in closed {
            #expect(whole[id] == tree, "block \(id) changed after it closed")
        }
    }
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
