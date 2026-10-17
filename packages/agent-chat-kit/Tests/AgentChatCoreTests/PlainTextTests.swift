import AgentChatCore
import Testing

@Suite struct PlainTextTests {
    // What lands on the clipboard reads like the reply, without its syntax:
    // blank lines between blocks, a list's items on lines of their own, a
    // table's cells separated by tabs, code as written.
    @Test func aReplyCopiesAsItReads() {
        let markdown = """
        ## The fix

        The flake came from a **race**, see [the docs](https://example.com) and `Store.save`.
        It reflows.

        1. Write to a temporary file.
        2. Rename it:
           - atomic
           - same volume

        ```swift
        let tmp = url
        try data.write(to: tmp)
        ```

        | Runs | Before |
        | --- | --- |
        | 50 | 3 failed |

        > Local storage only.

        - [x] tests pass
        - [ ] cache
        """
        #expect(PlainText.of(markdown: markdown) == """
        The fix

        The flake came from a race, see the docs and Store.save. It reflows.

        1. Write to a temporary file.
        2. Rename it:
          • atomic
          • same volume

        let tmp = url
        try data.write(to: tmp)

        Runs\tBefore
        50\t3 failed

        Local storage only.

        ☑ tests pass
        ☐ cache
        """)
    }
}
