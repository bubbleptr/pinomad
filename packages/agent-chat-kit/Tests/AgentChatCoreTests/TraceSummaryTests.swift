import AgentChatCore
import Foundation
import Testing

@Suite struct TraceSummaryTests {
    let start = Date(timeIntervalSince1970: 1_000)

    @Test func aLiveRunNamesTheCallInProgressAndCountsToNow() {
        let trace = AgentTrace(
            phase: .acting,
            steps: [
                .thinking(id: "t", text: "Look at the tests first.", isLive: false),
                .tools(id: "a", calls: [
                    ToolCall(id: "1", name: "read", state: .succeeded),
                    ToolCall(id: "2", name: "bash", state: .running),
                ]),
            ],
            startedAt: start
        )
        let summary = trace.summary(at: start.addingTimeInterval(12.4))
        #expect(summary.headline == .running(tool: "bash"))
        #expect(summary.elapsed == .seconds(12))
    }

    @Test func aFinishedRunCountsItsTopLevelCallsAndStopsTheClock() {
        let script = ToolCall(id: "3", name: "codemode", state: .succeeded, children: [
            ToolCall(id: "3a", name: "read", state: .succeeded),
            ToolCall(id: "3b", name: "grep", state: .failed),
        ])
        let trace = AgentTrace(
            phase: .answering,
            steps: [
                .tools(id: "a", calls: [ToolCall(id: "1", name: "read", state: .succeeded)]),
                .interim(id: "i", text: "That file is generated; checking its source."),
                .tools(id: "b", calls: [ToolCall(id: "2", name: "edit", state: .failed), script]),
            ],
            startedAt: start,
            endedAt: start.addingTimeInterval(65)
        )
        let summary = trace.summary(at: start.addingTimeInterval(90))
        #expect(summary.headline == .worked)
        #expect(summary.toolCount == 3)
        #expect(summary.failedToolCount == 1)
        #expect(summary.elapsed == .seconds(65))
    }

    @Test func aRunWithoutToolsOnlyThought() {
        let trace = AgentTrace(
            phase: .settled,
            steps: [.thinking(id: "t", text: "Easy one.", isLive: false)],
            startedAt: start,
            endedAt: start.addingTimeInterval(3)
        )
        #expect(trace.summary(at: start).headline == .thought)
    }

    @Test func aFailedRunSaysSoWhateverItDid() {
        let trace = AgentTrace(
            phase: .settled,
            outcome: .failed,
            steps: [.tools(id: "a", calls: [ToolCall(id: "1", name: "bash", state: .succeeded)])]
        )
        #expect(trace.summary(at: start).headline == .failed)
        #expect(trace.summary(at: start).elapsed == nil)
    }
}
