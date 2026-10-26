import Foundation
import Network

/// The inputs that decide whether the session must be told the network
/// changed: reachability plus the concrete addresses behind it. Wi-Fi with a
/// new address (a different network) is a change even though the status and
/// interface type stayed `satisfied`.
public struct NetworkPathSignature: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case satisfied, unsatisfied, requiresConnection
    }

    public var status: Status
    public var addresses: [NetworkAddress]

    public init(status: Status, addresses: [NetworkAddress]) {
        self.status = status
        self.addresses = addresses
    }

    /// The same set of addresses is the same path even if the interface
    /// enumeration came back in another order.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.status == rhs.status && Set(lhs.addresses) == Set(rhs.addresses)
    }

    public init(path: NWPath, addresses: [NetworkAddress]) {
        switch path.status {
        case .satisfied: status = .satisfied
        case .unsatisfied: status = .unsatisfied
        case .requiresConnection: status = .requiresConnection
        @unknown default: status = .unsatisfied
        }
        self.addresses = addresses
    }
}

/// Decides which path callbacks are worth reporting. A callback that repeats
/// the last signature is ignored; this is the de-bounce that keeps
/// address-details-only churn from reaching the coordinator.
public struct NetworkChangeDetector: Sendable {
    private var last: NetworkPathSignature?

    public init() {}

    public mutating func shouldReport(_ signature: NetworkPathSignature) -> Bool {
        guard signature != last else { return false }
        last = signature
        return true
    }
}

/// `NWPathMonitor` → one `networkChanged` event per real path change.
///
/// `@unchecked`: every stored property is only touched on the monitor's
/// serial queue.
public final class NetworkMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "build.kieran.pinomad.path-monitor")
    private let debounce: TimeInterval
    private var detector = NetworkChangeDetector()
    private var pending: DispatchWorkItem?

    /// `debounce` coalesces a burst of callbacks (Wi-Fi drop → cellular up)
    /// into the final path; the detector drops callbacks that repeat it.
    public init(debounce: TimeInterval = 0.4) {
        self.debounce = debounce
    }

    public func start(_ handler: @escaping @Sendable () -> Void) {
        monitor.pathUpdateHandler = { [self] path in
            let signature = NetworkPathSignature(
                path: path, addresses: NetworkInterfaces.active())
            guard detector.shouldReport(signature) else { return }
            pending?.cancel()
            let work = DispatchWorkItem { handler() }
            pending = work
            queue.asyncAfter(deadline: .now() + debounce, execute: work)
        }
        monitor.start(queue: queue)
    }

    public func stop() {
        pending?.cancel()
        pending = nil
        monitor.cancel()
    }
}
