import AgentChatCore
import AgentChatKit
import Foundation
import Observation

/// A scripted agent run, played back at roughly the pace a real one streams.
@MainActor @Observable
final class Replay {
    private(set) var trace = AgentTrace(phase: .thinking, steps: [])
    let answer = StreamingMarkdown()

    func play() async {
        let start = Date()
        trace.startedAt = start
        do {
            try await stream(Self.thinking, chunk: 3, every: .milliseconds(25)) { text in
                self.trace.steps = [.thinking(id: "think", text: text, isLive: true)]
            }
            let thought: TraceStep = .thinking(id: "think", text: Self.thinking, isLive: false, duration: .seconds(4))
            trace.steps = [thought]

            trace.phase = .acting
            var calls: [ToolCall] = []
            for script in Self.firstCalls {
                calls.append(ToolCall(id: script.id, name: script.name, state: .running, input: script.input))
                trace.steps = [thought, .tools(id: "first", calls: calls)]
                for child in script.children {
                    calls[calls.count - 1].children.append(
                        ToolCall(id: child.id, name: child.name, state: .running, input: child.input)
                    )
                    trace.steps = [thought, .tools(id: "first", calls: calls)]
                    try await Task.sleep(for: child.takes)
                    calls[calls.count - 1].children[calls[calls.count - 1].children.count - 1].state = .succeeded
                    calls[calls.count - 1].children[calls[calls.count - 1].children.count - 1].output = child.output
                    calls[calls.count - 1].children[calls[calls.count - 1].children.count - 1].duration = child.takes
                    trace.steps = [thought, .tools(id: "first", calls: calls)]
                }
                try await Task.sleep(for: script.takes)
                calls[calls.count - 1].state = .succeeded
                calls[calls.count - 1].output = script.output
                calls[calls.count - 1].duration = script.takes
                trace.steps = [thought, .tools(id: "first", calls: calls)]
            }

            trace.phase = .thinking
            try await stream(Self.secondThinking, chunk: 4, every: .milliseconds(20)) { text in
                self.trace.steps = [thought, .tools(id: "first", calls: calls), .thinking(id: "think-2", text: text, isLive: true)]
            }
            let secondThought: TraceStep = .thinking(id: "think-2", text: Self.secondThinking, isLive: false, duration: .milliseconds(700))
            var steps = [thought, .tools(id: "first", calls: calls), secondThought, .interim(id: "interim", text: Self.interim)]
            trace.steps = steps

            trace.phase = .acting
            var edit = ToolCall(id: "edit", name: "edit", state: .running, input: "Sources/Upload/Store.swift")
            trace.steps = steps + [.tools(id: "second", calls: [edit])]
            try await Task.sleep(for: .milliseconds(900))
            edit.state = .succeeded
            edit.duration = .milliseconds(900)
            edit.diffStat = DiffStat(additions: 4, deletions: 2)
            var test = ToolCall(id: "test", name: "bash", state: .running, input: "swift test --filter UploadTests")
            trace.steps = steps + [.tools(id: "second", calls: [edit, test])]
            try await Task.sleep(for: .seconds(2))
            test.state = .succeeded
            test.duration = .seconds(2)
            test.output = "Test run with 14 tests in 3 suites passed after 1.92 seconds."
            steps += [.tools(id: "second", calls: [edit, test])]
            trace.steps = steps

            // A beat of quiet before the answer: the steps stay open while
            // the phase still reads as working, so the folded rows can be
            // seen before the trace folds itself away.
            trace.phase = .thinking
            try await Task.sleep(for: .milliseconds(2500))

            trace.phase = .answering
            trace.endedAt = Date()
            try await stream(Self.answer, chunk: 4, every: .milliseconds(30)) { _ in }
            answer.finish()
            trace.phase = .settled
        } catch {
            // Cancelled: a new replay took over.
        }
    }

    /// Streams text in uneven chunks, the way tokens arrive, into the answer
    /// when `update` ignores it, or wherever `update` puts the text so far.
    private func stream(_ text: String, chunk: Int, every pause: Duration, update: (String) -> Void) async throws {
        var shown = ""
        var rest = Substring(text)
        var size = chunk
        while !rest.isEmpty {
            let piece = rest.prefix(size)
            rest = rest.dropFirst(size)
            shown += piece
            if text == Self.answer { answer.append(String(piece)) } else { update(shown) }
            size = (size * 7 + 3) % (chunk * 2) + 1
            try await Task.sleep(for: pause)
        }
    }
}

extension Replay {
    struct ScriptedCall {
        let id: String
        let name: String
        let input: String
        var output: String = ""
        let takes: Duration
        /// Calls this one makes while it runs, each played in order.
        var children: [ScriptedCall] = []
    }

    static let thinking = """
    The test writes the file and reads it back right away. If the reader \
    wins the race it sees a partial write. Let me check how the store writes \
    — whether it writes in place or stages the bytes somewhere first. The \
    cache writer had the same flake last month and the fix there was an \
    atomic rename, so I want to compare the two paths before touching \
    anything. If it is the same race, the fix is small: write to a \
    temporary file next to the target and rename it into place.
    """

    static let firstCalls = [
        ScriptedCall(id: "read", name: "read", input: "Sources/Upload/Store.swift", output: "let data = try encoder.encode(record)\ntry data.write(to: url)", takes: .milliseconds(500)),
        ScriptedCall(
            id: "codemode", name: "codemode", input: "compare write paths",
            output: "Store writes in place; Cache stages then renames.",
            takes: .milliseconds(400),
            children: [
                ScriptedCall(id: "codemode-read", name: "read", input: "Sources/Upload/Cache.swift", output: "try data.write(to: tmp)\ntry tmp.rename(to: url)", takes: .milliseconds(600)),
                ScriptedCall(id: "codemode-bash", name: "bash", input: "swift run repro-write-race", output: "reader saw 3 partial writes in 50 runs", takes: .milliseconds(900)),
            ]
        ),
        ScriptedCall(id: "run", name: "bash", input: "swift test --filter UploadTests --repeat 50", output: "UploadTests.roundTrip failed 3 of 50 runs", takes: .seconds(2)),
    ]

    static let secondThinking = "Same race as the cache writer — atomic rename it is."

    static let interim = "It writes in place, so a reader can see half a file. Writing to a temporary file and renaming it is atomic."

    static let answer = """
    The flake came from a **race between writing and reading** the record: \
    `Store.save` wrote the file in place, so the test's read could land \
    halfway through a write.

    ## The fix

    1. Write to a temporary file next to the target.
    2. Rename it into place, which is atomic on the same volume.

    ```swift
    // Readers see the old file or the new one, never half of each.
    let tmp = url.appendingPathExtension("tmp")
    try data.write(to: tmp)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    ```

    ```diff
    -try data.write(to: url)
    +try data.write(to: tmp)
    +_ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    ```

    | Runs | Before | After |
    | --- | --- | --- |
    | 50 | 3 failed | all passed |

    > Network volumes don't promise an atomic rename, so this only fixes \
    local storage, which is all the app uses.

    - [x] `UploadTests` pass 50 times in a row
    - [ ] Same change for `Cache.swift`, if you want it
    """

    static let history = (
        trace: AgentTrace(
            phase: .settled,
            steps: [
                .thinking(id: "h-think", text: "Look at the test and the CI logs first.", isLive: false, duration: .seconds(2)),
                .tools(id: "h-tools", calls: [
                    ToolCall(id: "h1", name: "read", state: .succeeded, input: "Tests/UploadTests.swift", duration: .milliseconds(300)),
                    ToolCall(id: "h2", name: "bash", state: .succeeded, input: "gh run view --log-failed", duration: .seconds(3)),
                ]),
            ],
            startedAt: Date(timeIntervalSince1970: 0),
            endedAt: Date(timeIntervalSince1970: 14)
        ),
        answer: """
        It fails when the test reads the record **before the write finishes**. \
        CI machines are slower, which is why you mostly see it there.
        """
    )
}
