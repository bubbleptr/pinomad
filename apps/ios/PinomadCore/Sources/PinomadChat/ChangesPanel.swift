import PinomadCore

/// The overview sheet's change stat and the file list pushed from it: the
/// last result, whether a fetch is in flight, and which fetch is allowed
/// to land. Only the newest request wins, and closing the sheet ends the
/// epoch so a late answer cannot reach a reopened panel.
///
/// Fetches follow the Web overview card: on open, when a run settles, and
/// after a reconnect — never while a run is streaming edits or the
/// connection is down. Pushing the file list and refreshing it are
/// explicit asks and load regardless.
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
    /// Whether the last observation could fetch (connected and idle) —
    /// the trigger is its false-to-true edge: a run settling or the
    /// connection coming back.
    private var lastReady: Bool?

    public init() {}

    /// Show the sheet. Fetches now when idle and connected; otherwise the
    /// value is only the baseline, and the settle or reconnect fetches.
    public mutating func open(busy: Bool, connected: Bool) -> Token? {
        isOpen = true
        let ready = connected && !busy
        lastReady = ready
        return ready ? start() : nil
    }

    /// Pull-to-refresh or the Retry button. Refreshing a panel that is no
    /// longer open would start an orphaned request.
    public mutating func refresh() -> Token? {
        guard isOpen else { return nil }
        return start()
    }

    /// The file list was pushed: load it if nothing is on screen or on the
    /// way — opening mid-run deferred the first fetch.
    public mutating func load() -> Token? {
        guard isOpen, changes == nil, !loading else { return nil }
        return start()
    }

    /// Feed the conversation's busy and connection state. Returns a token
    /// only when the panel becomes able to fetch: a run finished, or the
    /// connection came back with no run going.
    public mutating func observe(busy: Bool, connected: Bool) -> Token? {
        guard isOpen else { return nil }
        let ready = connected && !busy
        let edge = lastReady == false && ready
        lastReady = ready
        return edge ? start() : nil
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
        lastReady = nil
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
