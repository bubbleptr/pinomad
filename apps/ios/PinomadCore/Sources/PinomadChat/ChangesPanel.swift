import PinomadCore

/// The conversation Changes sheet's state: the last result, whether a
/// fetch is in flight, and which fetch is allowed to land. Only the
/// newest request wins, and closing the sheet ends the epoch so a late
/// answer cannot reach a reopened panel.
///
/// The pure part exists so those rules stay testable without a live
/// session — the view only supplies call outcomes and busy snapshots.
public struct ChangesPanel: Equatable, Sendable {
    /// Identifies one fetch. Tokens are compared by generation only.
    public struct Token: Equatable, Sendable {
        let generation: Int
    }

    /// The last successful answer; kept across a refresh so the list does
    /// not blank out while the host recomputes it.
    public private(set) var changes: ConversationChanges?
    public private(set) var loading = false
    /// The newest fetch's failure. A failed refresh keeps `changes`.
    public private(set) var error: String?
    public private(set) var isOpen = false
    private var generation = 0
    /// The busy value observed last while open — the refresh trigger is
    /// its true-to-false edge, not busy alone.
    private var lastBusy: Bool?

    public init() {}

    /// Show the sheet and start its first fetch. The current busy value
    /// is only the baseline: opening while a run is already going still
    /// refreshes when that run settles.
    public mutating func open(busy: Bool) -> Token {
        isOpen = true
        lastBusy = busy
        return start()
    }

    /// Pull-to-refresh or the Retry button. Refreshing a panel that is no
    /// longer open would start an orphaned request.
    public mutating func refresh() -> Token? {
        guard isOpen else { return nil }
        return start()
    }

    /// Feed a busy snapshot from the conversation. Returns a token only on
    /// the falling edge (a run finished), when the Web dialog refreshes too.
    public mutating func observe(busy: Bool) -> Token? {
        guard isOpen else { return nil }
        let settled = lastBusy == true && !busy
        lastBusy = busy
        guard settled else { return nil }
        return start()
    }

    /// A successful fetch. The epoch check drops both an older overlapping
    /// request and anything that arrives after close.
    public mutating func land(_ token: Token, _ result: ConversationChanges) {
        guard accepts(token) else { return }
        changes = result
        error = nil
        loading = false
    }

    /// A failed fetch — the error is shown with Retry, and any old result
    /// stays available.
    public mutating func fail(_ token: Token, _ message: String) {
        guard accepts(token) else { return }
        error = message
        loading = false
    }

    /// The sheet went away: no in-flight answer belongs on screen anymore.
    public mutating func close() {
        isOpen = false
        lastBusy = nil
        generation += 1
        loading = false
    }

    private mutating func start() -> Token {
        generation += 1
        loading = true
        error = nil
        return Token(generation: generation)
    }

    private func accepts(_ token: Token) -> Bool {
        isOpen && token.generation == generation
    }
}
