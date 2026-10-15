import AgentChatCore
import Foundation
import Testing

@Suite struct ToolSummaryTests {
    @Test func aBurstBucketsCallsByVerbInFirstSeenOrder() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "read", state: .succeeded),
            ToolCall(id: "2", name: "bash", state: .succeeded),
            ToolCall(id: "3", name: "read_file", state: .succeeded),
        ])
        #expect(summary.label == .buckets([
            .init(verb: .read, count: 2),
            .init(verb: .ran, count: 1),
        ]))
    }

    @Test func aliasesShareTheShortNameVerb() {
        // str-replace buckets with edit; write_file keeps its own verb
        // rather than collapsing into edit.
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "write_file", state: .succeeded),
            ToolCall(id: "2", name: "str-replace", state: .succeeded),
            ToolCall(id: "3", name: "edit", state: .succeeded),
        ])
        #expect(summary.label == .buckets([
            .init(verb: .wrote, count: 1),
            .init(verb: .edited, count: 2),
        ]))
    }

    @Test func unknownToolsFallBackToUsed() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "crystal-ball", state: .succeeded),
            ToolCall(id: "2", name: "tarot", state: .succeeded),
        ])
        #expect(summary.label == .buckets([.init(verb: .used, count: 2)]))
    }

    @Test func aSingleCallKeepsItsTargetsFileName() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "read", state: .succeeded, input: "Sources/Upload/Store.swift"),
        ])
        #expect(summary.label == .single(verb: .read, target: "Store.swift", name: "read"))
    }

    @Test func aCommandTargetKeepsItsHead() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "bash", state: .succeeded, input: "swift test --filter UploadTests\nverbose second line"),
        ])
        #expect(summary.label == .single(verb: .ran, target: "swift test --filter UploadTests", name: "bash"))
    }

    @Test func aSingleCallWithoutATargetIsJustTheVerb() {
        let summary = ToolSummary(calls: [ToolCall(id: "1", name: "read", state: .succeeded)])
        #expect(summary.label == .single(verb: .read, target: nil, name: "read"))
    }

    @Test func aSingleUnknownCallKeepsItsNameForTheFallback() {
        let summary = ToolSummary(calls: [ToolCall(id: "1", name: "crystal", state: .succeeded)])
        #expect(summary.label == .single(verb: .used, target: nil, name: "crystal"))
    }

    @Test func diffStatsSumTopLevelCallsOnly() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "edit", state: .succeeded, diffStat: DiffStat(additions: 4, deletions: 2), children: [
                ToolCall(id: "1a", name: "edit", state: .succeeded, diffStat: DiffStat(additions: 9, deletions: 9)),
            ]),
            ToolCall(id: "2", name: "edit", state: .succeeded, diffStat: DiffStat(additions: 1, deletions: 0)),
        ])
        #expect(summary.diffStat == DiffStat(additions: 5, deletions: 2))
    }

    @Test func aBatchWithoutDiffsReportsNone() {
        let summary = ToolSummary(calls: [ToolCall(id: "1", name: "read", state: .succeeded)])
        #expect(summary.diffStat == nil)
    }

    @Test func failuresCountTopLevelCalls() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "bash", state: .failed),
            ToolCall(id: "2", name: "bash", state: .succeeded, children: [
                ToolCall(id: "2a", name: "read", state: .failed),
            ]),
        ])
        #expect(summary.failedCount == 1)
    }

    @Test func theLiveLabelNamesTheDeepestRunningCall() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "read", state: .succeeded),
            ToolCall(id: "2", name: "codemode", state: .running, children: [
                ToolCall(id: "2a", name: "read", state: .succeeded),
                ToolCall(id: "2b", name: "bash", state: .running, children: [
                    ToolCall(id: "2b1", name: "grep", state: .running),
                ]),
            ]),
        ])
        #expect(summary.running == .init(name: "codemode", nestedName: "grep"))
    }

    @Test func aCallWhoseChildrenAllFinishedNamesItself() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "codemode", state: .running, children: [
                ToolCall(id: "1a", name: "read", state: .succeeded),
            ]),
        ])
        #expect(summary.running == .init(name: "codemode", nestedName: nil))
    }

    @Test func aSettledBatchNamesNothingRunning() {
        let summary = ToolSummary(calls: [
            ToolCall(id: "1", name: "read", state: .succeeded),
            ToolCall(id: "2", name: "bash", state: .failed),
        ])
        #expect(summary.running == nil)
    }
}

@Suite struct ThoughtLengthTests {
    @Test func underASecondIsBrief() {
        #expect(Duration.milliseconds(900).thoughtLength == .brief)
        #expect(Duration.milliseconds(999).thoughtLength == .brief)
    }

    @Test func anythingLongerRoundsToWholeSeconds() {
        #expect(Duration.seconds(4).thoughtLength == .seconds(4))
        #expect(Duration.milliseconds(1500).thoughtLength == .seconds(2))
        #expect(Duration.milliseconds(1499).thoughtLength == .seconds(1))
    }

    @Test func aNegativeLengthClaimsNoNumber() {
        #expect(Duration.milliseconds(-5).thoughtLength == nil)
    }
}
