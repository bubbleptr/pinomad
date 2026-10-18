import PinomadCore
import Testing
@testable import PinomadChat

private let gpt = ModelRef(provider: "openai", modelId: "gpt-5")
private let sonnet = ModelRef(provider: "anthropic", modelId: "sonnet")
private let models = [
    ModelSummary(provider: "openai", modelId: "gpt-5", name: "GPT-5",
                 contextWindow: 200_000,
                 thinkingLevels: [.off, .low, .medium, .high], images: true),
    ModelSummary(provider: "anthropic", modelId: "sonnet", name: "Sonnet",
                 contextWindow: 200_000,
                 thinkingLevels: [.off, .low, .medium], images: true),
]
private let defaults = Defaults(model: gpt, thinkingLevel: .low)
private let agents = AgentRoles(roles: [
    AgentRole(name: "reviewer", description: "Reviews code",
              model: "openai/gpt-5", thinkingLevel: .high, prompt: "Review."),
], problems: [])

private func emptyOverrides() -> AgentDraftOverride {
    AgentDraftOverride(model: nil, level: nil)
}

@Suite struct AgentDraftPickTests {
    /// ADR-0023: an override is sent with the create, but never becomes the
    /// remembered pick — clearing the agent brings the old choice back.
    @Test func overridesDoNotWriteTheRememberedPick() {
        let remembered = ModelPick(model: sonnet, level: .medium)
        var state = AgentDraftPick(remembered: remembered)
        state.select("reviewer")
        state.setModel(gpt, models: models, defaults: defaults)
        state.setLevel(.high, models: models, defaults: defaults)

        #expect(state.remembered == remembered)
        #expect(state.overrides == AgentDraftOverride(model: gpt, level: .high))

        state.select(nil)
        #expect(state.remembered == remembered)
        #expect(state.pick(agents: agents, models: models, defaults: defaults) == ModelPick(model: sonnet, level: .medium))
    }

    /// The overrides belonged to the previous agent; picking another (or
    /// none) starts from full inheritance again.
    @Test func switchingOrClearingTheAgentDropsOverrides() {
        var state = AgentDraftPick()
        state.select("reviewer")
        state.setModel(gpt, models: models, defaults: defaults)
        state.setLevel(.high, models: models, defaults: defaults)
        #expect(state.overrides != emptyOverrides())

        state.select("other")
        #expect(state.overrides == emptyOverrides())
        #expect(state.send(agents: agents, models: models, defaults: defaults)?.model == nil)
        #expect(state.send(agents: agents, models: models, defaults: defaults)?.level == nil)

        state.setModel(sonnet, models: models, defaults: defaults)
        state.select(nil)
        #expect(state.overrides == emptyOverrides())
        #expect(state.send(agents: agents, models: models, defaults: defaults) == nil)
    }

    /// Only touched sides ride the create; inherited model/level resolve
    /// host-side from the role and must not be copied into the args.
    @Test func sendCarriesOnlyOverrides() {
        var state = AgentDraftPick()
        state.select("reviewer")

        let inherited = state.send(agents: agents, models: models, defaults: defaults)
        #expect(inherited?.agent == "reviewer")
        #expect(inherited?.model == nil)
        #expect(inherited?.level == nil)
        // Display still resolves the role's pin for the capsule.
        #expect(state.pick(agents: agents, models: models, defaults: defaults).model == gpt)

        state.setLevel(.medium, models: models, defaults: defaults)
        #expect(state.send(agents: agents, models: models, defaults: defaults)?.model == nil)
        #expect(state.send(agents: agents, models: models, defaults: defaults)?.level == .medium)

        state.setModel(sonnet, models: models, defaults: defaults)
        #expect(state.send(agents: agents, models: models, defaults: defaults)?.model == sonnet)
        #expect(state.send(agents: agents, models: models, defaults: defaults)?.level == .medium)
    }

    /// Without an agent the old draft-pick rule still holds: a new model
    /// clamps the level, and the level change is remembered.
    @Test func withoutAgentThePickStillClampsAndRemembers() {
        var state = AgentDraftPick()
        state.setModel(sonnet, models: models, defaults: defaults)
        #expect(state.remembered == ModelPick(model: sonnet, level: .low))
        state.setLevel(.medium, models: models, defaults: defaults)
        #expect(state.pick(agents: agents, models: models, defaults: defaults) == ModelPick(model: sonnet, level: .medium))
    }

    /// Another host has other models and agents — nothing carries over.
    @Test func resetDropsTheRememberedPickForAnotherHost() {
        var state = AgentDraftPick(remembered: ModelPick(model: gpt, level: .low),
                                   agent: "reviewer",
                                   overrides: AgentDraftOverride(model: sonnet, level: .high))
        state.reset()
        #expect(state.remembered == nil)
        #expect(state.agent == nil)
        #expect(state.overrides == emptyOverrides())
    }

    /// Dropping the agent after a create clears only the agent state; the
    /// remembered pick survives for the next draft.
    @Test func clearingAgentForTheNextDraftKeepsTheRememberedPick() {
        let remembered = ModelPick(model: gpt, level: .low)
        var state = AgentDraftPick(remembered: remembered, agent: "reviewer",
                                   overrides: AgentDraftOverride(model: sonnet, level: .high))
        state.clearAgent()
        #expect(state.agent == nil)
        #expect(state.overrides == emptyOverrides())
        #expect(state.remembered == remembered)
    }
}
