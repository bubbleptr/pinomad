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
            trace.steps = [.thinking(id: "think", text: Self.thinking, isLive: false)]

            trace.phase = .acting
            var calls: [ToolCall] = []
            for script in Self.firstCalls {
                calls.append(ToolCall(id: script.id, name: script.name, state: .running, input: script.input))
                trace.steps = steps(thinking: true, first: calls)
                try await Task.sleep(for: script.takes)
                calls[calls.count - 1].state = .succeeded
                calls[calls.count - 1].output = script.output
                calls[calls.count - 1].duration = script.takes
                trace.steps = steps(thinking: true, first: calls)
            }

            trace.phase = .thinking
            try await Task.sleep(for: .milliseconds(600))
            var steps = steps(thinking: true, first: calls)
            steps.append(.interim(id: "interim", text: Self.interim))
            trace.steps = steps

            trace.phase = .acting
            var edit = ToolCall(id: "edit", name: "edit", state: .running, input: "Sources/Upload/Store.swift")
            trace.steps = steps + [.tools(id: "second", calls: [edit])]
            try await Task.sleep(for: .milliseconds(900))
            edit.state = .succeeded
            edit.duration = .milliseconds(900)
            edit.output = "+4 −2"
            var test = ToolCall(id: "test", name: "bash", state: .running, input: "swift test --filter UploadTests")
            trace.steps = steps + [.tools(id: "second", calls: [edit, test])]
            try await Task.sleep(for: .seconds(2))
            test.state = .succeeded
            test.duration = .seconds(2)
            test.output = "Test run with 14 tests in 3 suites passed after 1.92 seconds."
            trace.steps = steps + [.tools(id: "second", calls: [edit, test])]

            trace.phase = .answering
            trace.endedAt = Date()
            try await stream(Self.answer, chunk: 4, every: .milliseconds(30)) { _ in }
            answer.finish()
            trace.phase = .settled
        } catch {
            // Cancelled: a new replay took over.
        }
    }

    private func steps(thinking: Bool, first calls: [ToolCall]) -> [TraceStep] {
        [.thinking(id: "think", text: Self.thinking, isLive: false), .tools(id: "first", calls: calls)]
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
        let output: String
        let takes: Duration
    }

    static let thinking = """
    The test writes the file and reads it back right away. If the reader \
    wins the race it sees a partial write. Let me check how the store writes.
    """

    static let firstCalls = [
        ScriptedCall(id: "read", name: "read", input: "Sources/Upload/Store.swift", output: "let data = try encoder.encode(record)\ntry data.write(to: url)", takes: .milliseconds(500)),
        ScriptedCall(id: "grep", name: "grep", input: "write(to: in Sources/", output: "Sources/Upload/Store.swift:42\nSources/Upload/Cache.swift:17", takes: .milliseconds(700)),
        ScriptedCall(id: "run", name: "bash", input: "swift test --filter UploadTests --repeat 50", output: "UploadTests.roundTrip failed 3 of 50 runs", takes: .seconds(2)),
    ]

    static let interim = "It writes in place, so a reader can see half a file. Writing to a temporary file and renaming it is atomic."

    static let answer = """
    The flake came from a **race between writing and reading** the record: \
    `Store.save` wrote the file in place, so the test's read could land \
    halfway through a write.

    ## The fix

    1. Write to a temporary file next to the target.
    2. Rename it into place, which is atomic on the same volume.

    ```swift
    let tmp = url.appendingPathExtension("tmp")
    try data.write(to: tmp)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
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
                .thinking(id: "h-think", text: "Look at the test and the CI logs first.", isLive: false),
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
