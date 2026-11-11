import Foundation
import PinomadCore

/// What the overview's context row reads. The core already derives
/// `ContextUsage` from the last qualifying reply; this turns it into the
/// percent and copy the view shows — nothing is re-counted here.
public struct ContextMeterReading: Equatable, Sendable {
    /// A nearly full window warns before the conversation compacts itself.
    public static let warningPercent = 80
    /// Counts beyond this are not a plausible context size. Bounding them
    /// here keeps every Int conversion below (and the breakdown's) in range.
    static let maxTokens = 1e12

    public let percent: Int?
    public let warning: Bool
    /// The row's figures, e.g. "42% · 84k / 200k".
    public let detail: String
    public let accessibilityLabel: String

    public init(_ usage: ContextUsage?) {
        self.init(used: usage?.used, window: usage?.window)
    }

    init(used: Double?, window: Double?) {
        guard let used, let window, Self.isKnown(used: used, window: window) else {
            percent = nil
            warning = false
            detail = "No usage data yet"
            accessibilityLabel = "Context usage unknown"
            return
        }
        let share = used / window
        let percent = Int((share * 100).rounded())
        // The percent stays honest when a smaller model makes used exceed
        // the window.
        self.percent = percent
        warning = percent >= Self.warningPercent
        detail = "\(percent)% · \(Self.formatTokens(used)) / \(Self.formatTokens(window))"
        accessibilityLabel =
            "Context \(percent)% used, \(Self.formatTokens(used)) of \(Self.formatTokens(window)) tokens"
    }

    /// A non-positive or non-finite window has no scale, and a count outside
    /// the plausible range would trap the Int conversions here and in the
    /// breakdown. The core filters some of these, but a provider can still
    /// report an absurd number; such a reading is unknown instead of a crash.
    static func isKnown(used: Double, window: Double) -> Bool {
        used.isFinite && used >= 0 && used < maxTokens
            && window.isFinite && window >= 1 && window < maxTokens
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
