import PinomadCore

/// One row in the picker's Agent section. A nil `name` is the
/// "No agent" row, so the picker can pass the row's name straight to
/// `setAgent`.
public struct AgentPickRow: Equatable, Sendable, Identifiable {
    public let name: String?
    /// What the role brings: its pinned model and level when it has them,
    /// else its description; or why it can't be picked.
    public let detail: String?
    public let selected: Bool
    /// False for a role whose pinned model the host doesn't offer, and for
    /// the current agent the host no longer lists: shown, never pickable
    /// (ADR-0023 §5).
    public let available: Bool

    public init(name: String?, detail: String?, selected: Bool, available: Bool = true) {
        self.name = name
        self.detail = detail
        self.selected = selected
        self.available = available
    }

    public var id: String { name ?? "" }

    /// "No agent" followed by the host's roles.
    public static func rows(selected: String?, roles: [AgentRole], models: [ModelSummary]) -> [AgentPickRow] {
        [AgentPickRow(name: nil, detail: nil, selected: selected == nil)]
            + roles.map { role in
                let description = role.description.isEmpty ? nil : role.description
                guard let pinned = role.model else {
                    let level = role.thinkingLevel.flatMap { thinkingLevelLabel(level: $0) }
                    return AgentPickRow(name: role.name, detail: level ?? description,
                                        selected: role.name == selected)
                }
                guard let summary = models.first(where: { "\($0.provider)/\($0.modelId)" == pinned }) else {
                    return AgentPickRow(name: role.name, detail: "\(pinned) isn't available",
                                        selected: role.name == selected, available: false)
                }
                let label = [summary.name ?? summary.modelId,
                             role.thinkingLevel.flatMap { thinkingLevelLabel(level: $0) }]
                    .compactMap { $0 }.joined(separator: " · ")
                return AgentPickRow(name: role.name, detail: label, selected: role.name == selected)
            }
    }
}

/// Which sides of the model pick a named agent fixes (ADR-0023 §5,
/// 2026-11-15): the ones its definition writes. Enforced in the client
/// only; to change a locked side, change the agent.
public struct ModelLock: Equatable, Sendable {
    public let agent: String?
    public let model: Bool
    public let level: Bool

    public static let none = ModelLock(agent: nil, model: false, level: false)

    public init(agent: String?, model: Bool, level: Bool) {
        self.agent = agent
        self.model = model
        self.level = level
    }

    /// A conversation's current agent against the host's roles.
    public init(current: String?, roles: [AgentRole]) {
        let role = roles.first { $0.name == current }
        self.init(agent: current, model: role?.model != nil, level: role?.thinkingLevel != nil)
    }

    /// The draft's sides that resolve from the picked agent.
    public init(draftAgent: String?, resolution: AgentDraft?) {
        guard let draftAgent, let resolution else {
            self = .none
            return
        }
        self.init(agent: draftAgent, model: resolution.modelFrom == .agent,
                  level: resolution.levelFrom == .agent)
    }
}

/// A conversation's current agent and, when it may change, the rows its
/// model panel offers. The FFI collapses the wire's explicit null and a
/// pre-5.18 host's absent field into one nil, so the protocol version
/// decides which summary field is the truth (ADR-0023, protocol 5.18).
public struct ConversationAgent: Equatable, Sendable {
    /// The agent the conversation runs as now, without the `@`.
    public let current: String?
    /// 5.18+ hosts only, never a subagent: the delegating call fixed a
    /// subagent's role (ADR-0023 §5).
    public let canSwitch: Bool
    /// What the Agent section shows. Empty when `canSwitch` is false.
    public let rows: [AgentPickRow]

    public init(summary: ConversationSummary, isSubagent: Bool, hostMinor: UInt32,
                roles: [AgentRole], models: [ModelSummary]) {
        let supportsSwitch = hostSupportsCall(hostMinor: hostMinor, method: "setAgent")
        // A subagent's role is the call-given one and never follows the
        // top-level current-agent rule (ADR-0023 §5).
        let current = Self.nonEmpty(isSubagent ? summary.role
                                               : (supportsSwitch ? summary.currentAgent : summary.role))
        self.current = current
        canSwitch = supportsSwitch && !isSubagent
        guard canSwitch else {
            rows = []
            return
        }
        var rows = AgentPickRow.rows(selected: current, roles: roles, models: models)
        // A file deleted or broken after selection is still the current
        // agent, shown checked but unavailable; switching away drops it.
        if let current, !roles.contains(where: { $0.name == current }) {
            rows.insert(AgentPickRow(name: current, detail: "No longer available", selected: true,
                                     available: false), at: 1)
        }
        self.rows = rows
    }

    /// Whether the model panel has anything to show. The panel is also the
    /// only way to clear a switchable agent, so an empty model list alone
    /// must not keep it shut.
    public func sheetHasContent(models: [ModelSummary]) -> Bool {
        canSwitch || !models.isEmpty
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
