import SwiftUI

/// The app's own buttons: they give under the finger and tap back. The
/// tap lands on touch-down, like a key. `haptic: false` for a button whose
/// action already has its own feedback (send), so it doesn't buzz twice.
struct PressStyle: ButtonStyle {
    var haptic = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
            .sensoryFeedback(.impact(weight: .light), trigger: configuration.isPressed) { _, pressed in
                haptic && pressed
            }
    }
}

/// A system-styled button (glass, bordered) that taps back once its action
/// runs, keeping the system's look and press.
struct Tactile<Base: PrimitiveButtonStyle>: PrimitiveButtonStyle {
    let base: Base

    func makeBody(configuration: Configuration) -> some View {
        TactileButton(configuration: configuration, base: base)
    }
}

private struct TactileButton<Base: PrimitiveButtonStyle>: View {
    let configuration: PrimitiveButtonStyleConfiguration
    let base: Base
    @State private var taps = 0

    var body: some View {
        Button(role: configuration.role) {
            taps += 1
            configuration.trigger()
        } label: {
            configuration.label
        }
        .buttonStyle(base)
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
    }
}

extension ButtonStyle where Self == PressStyle {
    static var press: PressStyle { PressStyle() }
}

extension PrimitiveButtonStyle {
    static func tactile<Base: PrimitiveButtonStyle>(_ base: Base) -> Tactile<Base> where Self == Tactile<Base> {
        Tactile(base: base)
    }
}
