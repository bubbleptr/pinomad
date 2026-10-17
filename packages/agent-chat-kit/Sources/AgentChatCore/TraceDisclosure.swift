/// Whether a trace shows its steps. It is open while the agent works, so the
/// work can be followed, and folds away once the answer starts, which is what
/// the reader came for. A choice made by hand sticks for the rest of the run.
public struct TraceDisclosure: Sendable, Equatable {
    public private(set) var isExpanded: Bool
    private var chosenByHand = false

    public init(phase: AgentTrace.Phase) {
        isExpanded = Self.follows(phase)
    }

    public mutating func update(phase: AgentTrace.Phase) {
        if !chosenByHand { isExpanded = Self.follows(phase) }
    }

    public mutating func toggle() {
        chosenByHand = true
        isExpanded.toggle()
    }

    private static func follows(_ phase: AgentTrace.Phase) -> Bool {
        phase == .thinking || phase == .acting
    }
}
