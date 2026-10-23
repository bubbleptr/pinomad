import PinomadCore

/// One row in a model sheet's Agent section. A nil `name` is the
/// "No agent" row, so the sheet can pass the row's name straight to
/// `setAgent`.
public struct AgentPickRow: Equatable, Sendable, Identifiable {
    public let name: String?
    /// The host's description of the role, when it has one.
    public let detail: String?
    public let selected: Bool
    /// False for the current agent the host no longer offers: the row stays
    /// visible and checked, but cannot be picked again.
    public let available: Bool

    public init(name: String?, detail: String?, selected: Bool, available: Bool = true) {
        self.name = name
        self.detail = detail
        self.selected = selected
        self.available = available
    }

    public var id: String { name ?? "" }

    /// "No agent" followed by the host's roles.
    public static func rows(selected: String?, roles: [AgentRole]) -> [AgentPickRow] {
        [AgentPickRow(name: nil, detail: nil, selected: selected == nil)]
            + roles.map { role in
                AgentPickRow(name: role.name,
                             detail: role.description.isEmpty ? nil : role.description,
                             selected: role.name == selected)
            }
    }
}

/// A conversation's current agent and, when it may change, the rows its
/// model sheet offers. The FFI collapses the wire's explicit null and a
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
                roles: [AgentRole]) {
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
        var rows = AgentPickRow.rows(selected: current, roles: roles)
        // A file deleted or broken after selection is still the current
        // agent, shown checked but unavailable; switching away drops it.
        if let current, !roles.contains(where: { $0.name == current }) {
            rows.insert(AgentPickRow(name: current, detail: nil, selected: true,
                                     available: false), at: 1)
        }
        self.rows = rows
    }

    /// Whether the model sheet has anything to show. The sheet is also the
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
