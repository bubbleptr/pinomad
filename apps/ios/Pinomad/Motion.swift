import SwiftUI

/// The app's two animation curves, so pages don't each pick their own.
enum Motion {
    /// Something arriving or leaving — a toast, a banner: fast out, eased
    /// in, no overshoot.
    static let reveal = Animation.timingCurve(0.22, 0.8, 0.36, 1, duration: 0.32)
    /// Something already on screen moving to its new place — a page, a
    /// height: a spring that doesn't bounce.
    static let settle = Animation.smooth(duration: 0.35)

    /// A bar or toast dropping in from the top edge; a fade alone under
    /// Reduce Motion.
    static func dropIn(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity)
    }
}
