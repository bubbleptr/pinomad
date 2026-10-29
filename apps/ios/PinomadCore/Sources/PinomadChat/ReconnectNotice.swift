/// When the bar says "Connecting…": only once a reconnect has outlasted a
/// grace window. The redial after the app returns from the background
/// usually lands well inside it, and then nothing shows at all.
public struct ReconnectNotice: Equatable, Sendable {
    public static let grace: Duration = .milliseconds(1_500)

    /// When the current outage's window started; nil while connected.
    public private(set) var since: ContinuousClock.Instant?

    public init() {}

    /// When the indicator is due, if a reconnect is under way.
    public var deadline: ContinuousClock.Instant? { since.map { $0 + Self.grace } }

    /// Feed every view's connection state. Only the first reconnecting view
    /// of an outage starts the window.
    public mutating func observe(reconnecting: Bool, at now: ContinuousClock.Instant) {
        if !reconnecting {
            since = nil
        } else if since == nil {
            since = now
        }
    }

    /// Back in the foreground: a socket that died while suspended went
    /// reconnecting before the app could redial, so the redial gets its own
    /// window.
    public mutating func restart(at now: ContinuousClock.Instant) {
        if since != nil { since = now }
    }

    public func isVisible(at now: ContinuousClock.Instant) -> Bool {
        deadline.map { now >= $0 } ?? false
    }
}
