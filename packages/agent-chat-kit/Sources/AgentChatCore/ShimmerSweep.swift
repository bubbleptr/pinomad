import Foundation

/// When a shimmer's band of light is where, across text of a given width.
/// The band moves at one speed whatever the text's length, then rests: a
/// fixed period swept a long row several times faster than a short one.
/// Lengths are in points, times in seconds.
public struct ShimmerSweep: Sendable, Equatable {
    /// In ems a second, so larger text sweeps proportionally faster.
    public static let speedEm = 8.0
    public static let bandEm = 2.6
    public static let rest = 1.6

    public let width: Double
    /// The band's own width.
    public let band: Double
    /// From just off the leading edge until just past the trailing one.
    public let sweepDuration: Double
    public var restDuration: Double { Self.rest }
    public var period: Double { sweepDuration + restDuration }

    /// `pointSize` is the text's em.
    public init(width: Double, pointSize: Double) {
        self.width = max(0, width)
        band = Self.bandEm * pointSize
        sweepDuration = (self.width + band) / (Self.speedEm * pointSize)
    }

    /// The band's leading edge, `elapsed` seconds into the first sweep: from
    /// `-band` to `width` with sine in-out easing, then parked past the end
    /// through the rest, and round again.
    public func bandOrigin(at elapsed: Double) -> Double {
        let t = max(0, elapsed).truncatingRemainder(dividingBy: period)
        let progress = min(1, t / sweepDuration)
        let eased = (1 - cos(.pi * progress)) / 2
        return -band + (width + band) * eased
    }
}
