import AgentChatCore
import Foundation
import Testing

@Suite struct TraceCapsuleTests {
    let start = Date(timeIntervalSince1970: 1_000)

    @Test func aWorkingRunShowsTheFirstLineOfWhatItLastSaid() {
        let trace = AgentTrace(
            phase: .acting,
            steps: [
                .interim(id: "i1", text: "Reading the config first."),
                .tools(id: "a", calls: [ToolCall(id: "1", name: "read", state: .succeeded)]),
                .interim(id: "i2", text: "## Found it\n\nThe cache key ignores the locale."),
                .tools(id: "b", calls: [ToolCall(id: "2", name: "bash", state: .running)]),
            ],
            startedAt: start
        )
        let capsule = trace.capsule(at: start.addingTimeInterval(42))
        #expect(capsule.label == .interim("Found it"))
        #expect(capsule.summary.elapsed == .seconds(42))
    }

    @Test func aBlankInterimDoesNotHideTheCurrentAction() {
        let trace = AgentTrace(
            phase: .acting,
            steps: [
                .interim(id: "i", text: "  \n"),
                .tools(id: "a", calls: [ToolCall(id: "1", name: "bash", state: .running)]),
            ]
        )
        #expect(trace.capsule(at: start).label == .running(ToolSummary.Running(name: "bash")))
    }

    @Test func withoutInterimsItNamesTheRunningTool() {
        let trace = AgentTrace(
            phase: .acting,
            steps: [
                .thinking(id: "t", text: "Run the suite.", isLive: false),
                .tools(id: "a", calls: [
                    ToolCall(id: "1", name: "read", state: .succeeded),
                    ToolCall(id: "2", name: "codemode", state: .running, children: [
                        ToolCall(id: "2a", name: "grep", state: .running),
                    ]),
                ]),
            ]
        )
        #expect(trace.capsule(at: start).label == .running(ToolSummary.Running(name: "codemode", nestedName: "grep")))
    }

    @Test func withoutARunningToolItIsThinking() {
        let streaming = AgentTrace(
            phase: .thinking,
            steps: [.thinking(id: "t", text: "Maybe the cache", isLive: true)]
        )
        #expect(streaming.capsule(at: start).label == .thinking)

        // Every call has its result and the next model call is in flight.
        let between = AgentTrace(
            phase: .acting,
            steps: [.tools(id: "a", calls: [ToolCall(id: "1", name: "bash", state: .succeeded)])]
        )
        #expect(between.capsule(at: start).label == .thinking)
    }

    @Test func onceTheAnswerStreamsItReadsAsTheFinishedSummary() {
        let trace = AgentTrace(
            phase: .answering,
            steps: [
                .interim(id: "i", text: "Patching the key."),
                .tools(id: "a", calls: [ToolCall(id: "1", name: "edit", state: .succeeded)]),
            ],
            startedAt: start,
            endedAt: start.addingTimeInterval(360)
        )
        let capsule = trace.capsule(at: start.addingTimeInterval(400))
        #expect(capsule.label == .finished(.worked))
        #expect(capsule.summary.elapsed == .seconds(360))
        #expect(capsule.summary.toolCount == 1)
    }

    @Test func aFailedOrStoppedRunSaysSoEvenMidStep() {
        let steps: [TraceStep] = [
            .interim(id: "i", text: "Trying the migration."),
            .tools(id: "a", calls: [ToolCall(id: "1", name: "bash", state: .running)]),
        ]
        let failed = AgentTrace(phase: .acting, outcome: .failed, steps: steps)
        #expect(failed.capsule(at: start).label == .finished(.failed))
        let stopped = AgentTrace(phase: .acting, outcome: .interrupted, steps: steps)
        #expect(stopped.capsule(at: start).label == .finished(.interrupted))
    }
}
