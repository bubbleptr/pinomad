import PinomadCore

/// The new-conversation draft's model/level state (ADR-0023). Without a named
/// agent it is the remembered `ModelPick`; with one it is the name plus the
/// sides the reader overrode. Inherited sides stay out of the overrides so the
/// host can resolve them from the role at create, and clearing the agent
/// returns to the untouched remembered pick.
public struct AgentDraftPick: Equatable, Sendable {
    /// The reader's own pick while no agent is chosen; nil until they choose
    /// (the host default applies).
    public private(set) var remembered: ModelPick?

    /// The picked named agent, nil for an unassigned conversation.
    public private(set) var agent: String?

    /// The sides changed on the picked agent. A missing side is inherited —
    /// never a copy of the role or host default.
    public private(set) var overrides: AgentDraftOverride

    public init(
        remembered: ModelPick? = nil,
        agent: String? = nil,
        overrides: AgentDraftOverride = AgentDraftOverride(model: nil, level: nil)
    ) {
        self.remembered = remembered
        self.agent = agent
        self.overrides = overrides
    }

    /// Switch to another named agent, or back to none. The overrides belonged
    /// to the previous pick, so they go with it.
    public mutating func select(_ agent: String?) {
        self.agent = agent
        overrides = AgentDraftOverride(model: nil, level: nil)
    }

    /// Start the next draft from "no agent". The remembered pick survives —
    /// only the agent and its overrides are per-draft.
    public mutating func clearAgent() {
        agent = nil
        overrides = AgentDraftOverride(model: nil, level: nil)
    }

    /// Drop the remembered pick too, e.g. when the session moves to another
    /// host whose models and agents are different.
    public mutating func reset() {
        remembered = nil
        clearAgent()
    }

    /// Change the model. With an agent this only records an override — the
    /// remembered pick is deliberately left alone. Without one it behaves
    /// like the plain draft pick always did: clamp the level to the model.
    public mutating func setModel(_ model: ModelRef, models: [ModelSummary], defaults: Defaults?) {
        if agent != nil {
            overrides = AgentDraftOverride(model: model, level: overrides.level)
            return
        }
        let levels = summaryOf(models: models, model: model)?.thinkingLevels ?? [.off]
        let current = pick(models: models, defaults: defaults)
        remembered = ModelPick(model: model,
                               level: clampLevel(levels: levels, want: current.level))
    }

    /// Change the level; with an agent it is an override only.
    public mutating func setLevel(_ level: ThinkingLevel, models: [ModelSummary], defaults: Defaults?) {
        if agent != nil {
            overrides = AgentDraftOverride(model: overrides.model, level: level)
            return
        }
        remembered = ModelPick(model: pick(models: models, defaults: defaults).model, level: level)
    }

    /// What the draft shows: the named-agent resolution while one is picked,
    /// else the reconciled remembered/default pick.
    public func pick(agents: AgentRoles? = nil, models: [ModelSummary], defaults: Defaults?) -> ModelPick {
        if let resolution = resolution(agents: agents, models: models, defaults: defaults) {
            return ModelPick(model: resolution.model, level: resolution.level)
        }
        let fallback = ModelPick(model: defaults?.model,
                                 level: defaults?.thinkingLevel ?? .off)
        return reconcileDraftPick(models: models, defaults: defaults,
                                  remembered: remembered ?? fallback)
    }

    /// The core's named-agent derivation while one is picked, nil otherwise.
    /// The UI reads its display values, sources and blocking problem.
    public func resolution(agents: AgentRoles?, models: [ModelSummary], defaults: Defaults?) -> AgentDraft? {
        guard let agent else { return nil }
        return resolveAgentDraft(agent: agent, agents: agents, models: models,
                                 defaults: defaults, overrides: overrides)
    }

    /// `createConversation`'s args with an agent: the name plus only the
    /// overridden sides. Nil when no agent is picked, where the caller sends
    /// the resolved pick as before.
    public func send(agents: AgentRoles?, models: [ModelSummary], defaults: Defaults?) -> AgentDraftSend? {
        guard let resolution = resolution(agents: agents, models: models, defaults: defaults),
              let agent else { return nil }
        return AgentDraftSend(agent: agent, model: resolution.sendModel, level: resolution.sendLevel)
    }
}

/// The named-agent part of a `createConversation` call.
public struct AgentDraftSend: Equatable, Sendable {
    public let agent: String
    /// Only a user override; nil means the host resolves the role/host model.
    public let model: ModelRef?
    /// Only a user override; nil means the host resolves the role/host level.
    public let level: ThinkingLevel?

    public init(agent: String, model: ModelRef?, level: ThinkingLevel?) {
        self.agent = agent
        self.model = model
        self.level = level
    }
}
