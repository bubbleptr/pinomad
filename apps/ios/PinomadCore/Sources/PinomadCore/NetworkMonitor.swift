import Foundation
import Network

/// `NWPathMonitor` → `networkChanged` events. The core decides what a
/// change means (it cuts a pending reconnect backoff short); the monitor
/// just reports that the path changed.
///
/// `@unchecked`: `lastStatus` is only touched on the monitor's serial queue.
public final class NetworkMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "build.kieran.pinomad.path-monitor")
    private var lastStatus: NWPath.Status?

    public init() {}

    /// Start reporting. `handler` is called once per status change on the
    /// monitor's queue — it should only yield into the session.
    public func start(_ handler: @escaping @Sendable () -> Void) {
        monitor.pathUpdateHandler = { [self] path in
            // The monitor fires on details-only churn too (addresses,
            // DNS); the core only cares about reachability flips.
            if path.status != lastStatus {
                lastStatus = path.status
                handler()
            }
        }
        monitor.start(queue: queue)
    }

    public func stop() {
        monitor.cancel()
    }
}
