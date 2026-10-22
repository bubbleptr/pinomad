import Foundation
import PinomadCore

/// What the composer's context meter reads. The core already derives
/// `ContextUsage` from the last qualifying reply; this turns it into the
/// percent, ring fill, and copy the view shows — nothing is re-counted here.
public struct ContextMeterReading: Equatable, Sendable {
    /// A nearly full window warns before the conversation compacts itself.
    public static let warningPercent = 80
    /// Counts beyond this are not a plausible context size. Bounding them
    /// here keeps every Int conversion below in range.
    private static let maxTokens = 1e12

    public let percent: Int?
    /// A fraction for the ring, capped at a full turn.
    public let fill: Double
    public let warning: Bool
    public let text: String
    /// The popover's figures, e.g. "84k / 200k".
    public let detail: String
    public let accessibilityLabel: String

    public init(_ usage: ContextUsage?) {
        self.init(used: usage?.used, window: usage?.window)
    }

    init(used: Double?, window: Double?) {
        // A non-positive or non-finite window has no scale, and a count
        // outside the plausible range would trap the Int conversions below.
        // The core filters some of these, but a provider can still report
        // an absurd number; fall back to "unknown" instead of crashing.
        guard let used, let window,
              used.isFinite, used >= 0, used < Self.maxTokens,
              window.isFinite, window >= 1, window < Self.maxTokens else {
            percent = nil
            fill = 0
            warning = false
            text = "—"
            detail = "No usage data yet"
            accessibilityLabel = "Context usage unknown"
            return
        }
        let share = used / window
        let percent = Int((share * 100).rounded())
        self.percent = percent
        // The text stays honest when a smaller model makes used exceed the
        // window; only the ring saturates.
        fill = min(1, share)
        warning = percent >= Self.warningPercent
        text = "\(percent)%"
        detail = "\(Self.formatTokens(used)) / \(Self.formatTokens(window))"
        accessibilityLabel =
            "Context \(percent)% used, \(Self.formatTokens(used)) of \(Self.formatTokens(window)) tokens"
    }

    /// Matches the web's `formatTokens`: whole thousands below a million,
    /// one decimal at or above it, trailing ".0" dropped.
    public static func formatTokens(_ tokens: Double) -> String {
        // The initializer already bounds its inputs, but this is public and
        // must not trap when handed an unvalidated count.
        guard tokens.isFinite, tokens >= 0, tokens < Self.maxTokens else { return "—" }
        if tokens >= 1_000_000 {
            let tenths = (tokens / 100_000).rounded(.toNearestOrAwayFromZero)
            return tenths.truncatingRemainder(dividingBy: 10) == 0
                ? "\(Int(tenths / 10))M"
                : String(format: "%.1fM", tenths / 10)
        }
        if tokens >= 1_000 {
            return "\(Int((tokens / 1_000).rounded()))k"
        }
        return "\(Int(tokens.rounded()))"
    }
}
