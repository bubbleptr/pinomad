import AgentChatCore
import Testing

@Suite struct TraceDisclosureTests {
    @Test func followsTheRunUntilTheAnswerStarts() {
        var disclosure = TraceDisclosure(phase: .thinking)
        #expect(disclosure.isExpanded)
        disclosure.update(phase: .acting)
        #expect(disclosure.isExpanded)
        disclosure.update(phase: .answering)
        #expect(!disclosure.isExpanded)
        disclosure.update(phase: .settled)
        #expect(!disclosure.isExpanded)
    }

    @Test func aTraceFromHistoryStartsCollapsed() {
        #expect(!TraceDisclosure(phase: .settled).isExpanded)
    }

    @Test func collapsingByHandSticksWhileTheRunGoesOn() {
        var disclosure = TraceDisclosure(phase: .acting)
        disclosure.toggle()
        disclosure.update(phase: .thinking)
        disclosure.update(phase: .acting)
        #expect(!disclosure.isExpanded)
    }

    @Test func expandingByHandSticksPastTheAnswer() {
        var disclosure = TraceDisclosure(phase: .thinking)
        disclosure.update(phase: .answering)
        disclosure.toggle()
        disclosure.update(phase: .settled)
        #expect(disclosure.isExpanded)
    }
}
