import PinomadCore
import Testing
@testable import PinomadChat

private func summary(
    role: String? = nil,
    currentAgent: String? = nil,
    kind: SummaryKind = .conversation
) -> ConversationSummary {
    ConversationSummary(
        id: 1, kind: kind, parent: nil, forkedAt: nil, title: "Demo",
        status: nil, updatedAt: nil, label: nil, role: role,
        currentAgent: currentAgent, activity: nil
    )
}

private let roles = [
    AgentRole(name: "reviewer", description: "Reviews code",
              model: nil, thinkingLevel: nil, prompt: ""),
    AgentRole(name: "planner", description: "", model: nil, thinkingLevel: nil, prompt: ""),
]

/// The FFI collapses the wire's explicit null and a pre-5.18 host's absent
/// field into one nil, so the protocol version decides which summary field
/// is the truth (ADR-0023, 5.18).
@Suite struct ConversationAgentTests {
    @Test func currentAgentFollowsTheHostVersion() {
        let value = summary(role: "reviewer", currentAgent: "planner")

        let old = ConversationAgent(summary: value, isSubagent: false, hostMinor: 17, roles: roles)
        #expect(old.current == "reviewer")
        #expect(!old.canSwitch)

        let current = ConversationAgent(summary: value, isSubagent: false, hostMinor: 18, roles: roles)
        #expect(current.current == "planner")
        #expect(current.canSwitch)
    }

    /// On 5.18 an explicit null means no agent, not an absent field that
    /// should fall back to the creation-time role.
    @Test func a518HostWithoutAnAgentDoesNotFallBackToRole() {
        let value = summary(role: "reviewer", currentAgent: nil)
        let agent = ConversationAgent(summary: value, isSubagent: false, hostMinor: 18, roles: roles)

        #expect(agent.current == nil)
        #expect(agent.rows.first?.name == nil)
        #expect(agent.rows.first?.selected == true)
    }

    /// A subagent's agent is the call-given role, even on a 5.18 host that
    /// can switch top-level conversations and even if the summary omits
    /// `currentAgent`.
    @Test func aSubagentKeepsItsRoleAndCannotSwitch() {
        let value = summary(role: "reviewer", currentAgent: nil, kind: .subagent)
        let agent = ConversationAgent(summary: value, isSubagent: true, hostMinor: 18, roles: roles)

        #expect(agent.current == "reviewer")
        #expect(!agent.canSwitch)
        #expect(agent.rows.isEmpty)
    }

    /// A current agent whose file was deleted or broke stays visible and
    /// checked, but the row is not selectable.
    @Test func aMissingRoleStaysSelectedButUnavailable() {
        let value = summary(currentAgent: "gone", kind: .conversation)
        let agent = ConversationAgent(summary: value, isSubagent: false, hostMinor: 18, roles: roles)

        let missing = agent.rows.filter { $0.name == "gone" }
        #expect(missing.count == 1)
        #expect(missing.first?.selected == true)
        #expect(missing.first?.available == false)
    }

    /// Switching to a role the host does offer drops the unavailable row.
    @Test func switchingAwayDropsTheMissingRole() {
        let before = ConversationAgent(summary: summary(currentAgent: "gone"),
                                       isSubagent: false, hostMinor: 18, roles: roles)
        #expect(before.rows.contains { $0.name == "gone" })

        let after = ConversationAgent(summary: summary(currentAgent: "planner"),
                                      isSubagent: false, hostMinor: 18, roles: roles)
        #expect(!after.rows.contains { $0.name == "gone" })
        #expect(after.rows.first { $0.name == "planner" }?.selected == true)
    }

    /// The sheet is the only way to clear a switchable agent, so an empty
    /// model list alone must not keep it shut on a 5.18+ host.
    @Test func aSwitchableAgentKeepsTheSheetOpenWithoutModels() {
        let current = ConversationAgent(summary: summary(currentAgent: "reviewer"),
                                        isSubagent: false, hostMinor: 18, roles: roles)
        #expect(current.sheetHasContent(models: []))

        let old = ConversationAgent(summary: summary(role: "reviewer"),
                                    isSubagent: false, hostMinor: 17, roles: roles)
        #expect(!old.sheetHasContent(models: []))
    }

    /// "No agent" is the row with a nil name; selecting it sends nil.
    @Test func noAgentIsTheNilRow() {
        let rows = AgentPickRow.rows(selected: "reviewer", roles: roles)
        let none = rows.first

        #expect(none?.name == nil)
        #expect(none?.selected == false)
        #expect(rows.first { $0.name == "reviewer" }?.selected == true)

        let cleared = ConversationAgent(summary: summary(currentAgent: nil),
                                        isSubagent: false, hostMinor: 18, roles: roles)
        #expect(cleared.rows.first?.name == nil)
        #expect(cleared.rows.first?.selected == true)
    }
}
