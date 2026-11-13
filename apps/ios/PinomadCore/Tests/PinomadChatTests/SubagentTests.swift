import Foundation
import PinomadCore
import Testing
@testable import PinomadChat

private func subagent(
    _ id: UInt64,
    parent: UInt64 = 1,
    lifecycle: SubagentLifecycle? = .background,
    name: String? = nil,
    status: ConversationStatus? = nil,
    label: String? = nil
) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: .subagent, lifecycle: lifecycle, name: name, model: nil,
        parent: parent, forkedAt: nil, title: nil, status: status, updatedAt: nil,
        label: label, role: nil, activity: nil
    )
}

private func organized(root children: [ConversationNode]) -> Organized {
    let root = ConversationSummary(
        id: 1, kind: .conversation, parent: nil, forkedAt: nil, title: "Root",
        status: nil, updatedAt: nil, label: nil, role: nil, activity: nil
    )
    return Organized(chats: [ConversationNode(summary: root, children: children)], projects: [], archived: [])
}

private func leaf(_ summary: ConversationSummary) -> ConversationNode {
    ConversationNode(summary: summary, children: [])
}

@Suite("Subagents")
struct SubagentTests {
    // MARK: Stop

    @Test func aNamedSubagentAtWorkCanBeStoppedWhateverItsLifecycle() {
        #expect(canStopSubagent(summary: subagent(2, lifecycle: .background, name: "reviewer", status: .running), hostMinor: 33))
        #expect(canStopSubagent(summary: subagent(2, lifecycle: .foreground, name: "reviewer", status: .running), hostMinor: 33))
        #expect(canStopSubagent(summary: subagent(2, lifecycle: nil, name: "reviewer", status: .running), hostMinor: 33))
    }

    @Test func anIdleOrFailedSubagentHasNothingToStop() {
        #expect(!canStopSubagent(summary: subagent(2, name: "reviewer", status: nil), hostMinor: 33))
        #expect(!canStopSubagent(summary: subagent(2, name: "reviewer", status: .failed), hostMinor: 33))
    }

    /// An older host does not tell the dispatcher who stopped it, and a
    /// subagent from before ADR-0046 has no record there.
    @Test func noStopOnAnOldHostOrForASubagentFromBeforeNames() {
        #expect(!canStopSubagent(summary: subagent(2, name: "reviewer", status: .running), hostMinor: 32))
        #expect(!canStopSubagent(summary: subagent(2, name: nil, status: .running), hostMinor: 33))
    }

    // MARK: Names

    @Test func subagentGoesByItsName() {
        #expect(conversationName(summary: subagent(2, name: "reviewer", label: "Audit auth")) == "reviewer")
        #expect(conversationName(summary: subagent(2, name: nil, label: "Audit auth")) == "Audit auth")
    }

    // MARK: Overview

    /// Every subagent of the family is a task (ADR-0047 §1): a background
    /// one at work is listed by name next to a foreground one, and the idle
    /// one after them as finished.
    @Test func overviewListsBackgroundSubagentsWithTheRest() {
        let tree = organized(root: [
            leaf(subagent(2, lifecycle: .foreground, name: "tester", status: .running)),
            leaf(subagent(3, lifecycle: .background, name: "auditor", status: .running)),
            leaf(subagent(4, lifecycle: .background, name: "linter", status: nil)),
        ])
        let overview = SubagentOverview.of(organized: tree, conversation: 1)
        #expect(overview?.rows.map(\.name) == ["tester", "auditor", "linter"])
        #expect(overview?.rows.map(\.tone) == [.running, .running, .done])
    }
}
