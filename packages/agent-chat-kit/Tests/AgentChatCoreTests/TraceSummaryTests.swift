import AgentChatCore
import Foundation
import Testing

@Suite struct TraceSummaryTests {
    let start = Date(timeIntervalSince1970: 1_000)

    @Test func aRunCallingToolsReadsAsWorkingAndCountsToNow() {
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
        #expect(summary.headline == .working)
        #expect(summary.elapsed == .seconds(12))
    }

    @Test(arguments: [
        (after: 0.4, seconds: 1),
        (after: 0.6, seconds: 1),
        (after: 59.6, seconds: 60),
    ])
    func aSettledRunRoundsToWholeSeconds(after: TimeInterval, seconds: Int) {
        let trace = AgentTrace(
            phase: .settled,
            steps: [],
            startedAt: start,
            endedAt: start.addingTimeInterval(after)
        )
        #expect(trace.summary(at: start.addingTimeInterval(120)).elapsed == .seconds(seconds))
    }

    @Test func aRunWithoutAMeasuredSpanShowsNoDuration() {
        let incomplete = AgentTrace(phase: .settled, steps: [], startedAt: start)
        #expect(incomplete.summary(at: start.addingTimeInterval(10)).elapsed == nil)

        let unanchored = AgentTrace(
            phase: .settled,
            steps: [],
            endedAt: start.addingTimeInterval(5)
        )
        #expect(unanchored.summary(at: start.addingTimeInterval(10)).elapsed == nil)
    }

    @Test func aLiveClockFloorsSoItNeverRunsAhead() {
        // Rounding a live clock would turn 0.5s into 1s early, and a
        // one-second floor would claim 1s at the start; both make the clock
        // jump before the second has elapsed.
        let trace = AgentTrace(phase: .acting, steps: [], startedAt: start)
        #expect(trace.summary(at: start.addingTimeInterval(0.6)).elapsed == .seconds(0))
        #expect(trace.summary(at: start.addingTimeInterval(1.6)).elapsed == .seconds(1))
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
