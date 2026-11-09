/// One host runtime's process subscription. The overview keeps the runtime
/// that opened the watch, so closing the sheet always sends the unwatch to
/// that host even after focus moved elsewhere.
@MainActor
public protocol ProcessWatching: AnyObject {
    func watchProcesses(_ root: UInt64)
    func unwatchProcesses()
}

/// The overview's process watch, bound to the runtime that opened it.
@MainActor
public final class ProcessWatchSession {
    private var runtime: (any ProcessWatching)?

    public init() {}

    /// Subscribe `root` on `runtime`, ending any previous watch first.
    public func open(root: UInt64, on runtime: (any ProcessWatching)?) {
        close()
        self.runtime = runtime
        runtime?.watchProcesses(root)
    }

    /// End the watch on the runtime that opened it. Safe to call twice.
    public func close() {
        runtime?.unwatchProcesses()
        runtime = nil
    }
}
