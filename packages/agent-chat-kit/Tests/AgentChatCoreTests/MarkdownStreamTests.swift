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
}
