import PinomadCore
import Testing
@testable import PinomadChat

private func model(_ provider: String, _ id: String, _ name: String) -> ModelSummary {
    ModelSummary(provider: provider, modelId: id, name: name, contextWindow: nil,
                 thinkingLevels: [.off, .low, .high], images: nil)
}

private let models = [model("anthropic", "opus", "Opus 4.1"), model("openai", "gpt-5", "GPT-5")]

private let pinning = AgentRole(name: "reviewer", description: "Reviews code",
                                model: "anthropic/opus", thinkingLevel: .high, prompt: "")
private let levelOnly = AgentRole(name: "planner", description: "Plans", model: nil,
                                  thinkingLevel: .low, prompt: "")
private let stale = AgentRole(name: "writer", description: "Writes", model: "google/gemini",
                              thinkingLevel: nil, prompt: "")
private let plain = AgentRole(name: "helper", description: "Helps", model: nil,
                              thinkingLevel: nil, prompt: "")

/// ADR-0023 §5 (2026-11-15): a named agent locks the sides its definition
/// pins, and an agent whose pinned model the host doesn't offer can't be
/// picked.
@Suite struct AgentLockTests {
    @Test func anAgentLocksOnlyTheSidesItPins() {
        let roles = [pinning, levelOnly, plain]
        #expect(ModelLock(current: "reviewer", roles: roles) == ModelLock(agent: "reviewer", model: true, level: true))
        #expect(ModelLock(current: "planner", roles: roles) == ModelLock(agent: "planner", model: false, level: true))
        #expect(ModelLock(current: "helper", roles: roles) == ModelLock(agent: "helper", model: false, level: false))
        #expect(ModelLock(current: nil, roles: roles) == .none)
        // A current agent the host no longer lists pins nothing we know of.
        #expect(ModelLock(current: "gone", roles: roles) == ModelLock(agent: "gone", model: false, level: false))
    }

    /// The draft reads the core's sources: a side resolved from the agent
    /// is locked, one from the host default is the reader's.
    @Test func theDraftLocksTheSidesResolvedFromTheAgent() {
        let agents = AgentRoles(roles: [pinning, levelOnly], problems: [])
        let none = AgentDraftOverride(model: nil, level: nil)
        let defaults = Defaults(model: ModelRef(provider: "openai", modelId: "gpt-5"), thinkingLevel: .off)

        let reviewer = resolveAgentDraft(agent: "reviewer", agents: agents, models: models,
                                         defaults: defaults, overrides: none)
        #expect(ModelLock(draftAgent: "reviewer", resolution: reviewer)
            == ModelLock(agent: "reviewer", model: true, level: true))

        let planner = resolveAgentDraft(agent: "planner", agents: agents, models: models,
                                        defaults: defaults, overrides: none)
        #expect(ModelLock(draftAgent: "planner", resolution: planner)
            == ModelLock(agent: "planner", model: false, level: true))

        #expect(ModelLock(draftAgent: nil, resolution: nil) == .none)
    }

    @Test func anAgentWhosePinnedModelIsMissingCannotBePicked() {
        let rows = AgentPickRow.rows(selected: nil, roles: [pinning, stale, plain], models: models)

        let writer = rows.first { $0.name == "writer" }
        #expect(writer?.available == false)
        #expect(writer?.detail == "google/gemini isn't available")

        // A pinned, offered model reads as the pick it brings.
        #expect(rows.first { $0.name == "reviewer" }?.detail == "Opus 4.1 · High")
        #expect(rows.first { $0.name == "reviewer" }?.available == true)
        // Nothing pinned: the description.
        #expect(rows.first { $0.name == "helper" }?.detail == "Helps")
    }

    @Test func aCurrentAgentThatIsGoneSaysSo() {
        let summary = ConversationSummary(
            id: 1, kind: .conversation, parent: nil, forkedAt: nil, title: "Demo",
            status: nil, updatedAt: nil, label: nil, role: nil,
            currentAgent: "gone", activity: nil)
        let agent = ConversationAgent(summary: summary, isSubagent: false, hostMinor: 18,
                                      roles: [plain], models: models)
        let gone = agent.rows.first { $0.name == "gone" }
        #expect(gone?.available == false)
        #expect(gone?.detail == "No longer available")
    }
}
