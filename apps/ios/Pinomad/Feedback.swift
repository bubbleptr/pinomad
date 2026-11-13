import PinomadChat
import SwiftUI
import UIKit

/// Host and core notices and one-off action failures, newest at the bottom.
/// An error stays until closed (tap, or the x); the rest leave on their own.
struct ToastStack: View {
    let model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 6) {
            ForEach(model.toasts) { toast in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let icon = toast.level.icon {
                        Image(icon).foregroundStyle(toast.level.tint)
                    }
                    Text(toast.message)
                        .font(.footnote)
                        .lineLimit(3)
                    if toast.sticky {
                        Image(.x)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassEffect(.regular, in: .rect(cornerRadius: 18))
                .contentShape(.rect)
                .onTapGesture { model.dismissToast(toast.id) }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Dismisses this message")
                .transition(Motion.dropIn(reduceMotion: reduceMotion))
            }
        }
        .padding(.horizontal, 16)
        .animation(Motion.reveal, value: model.toasts.map(\.id))
        // Only an error arriving buzzes; a dismissal also changes the ids.
        .sensoryFeedback(trigger: model.toasts.map(\.id)) { old, new in
            let added = Set(new).subtracting(old)
            return model.toasts.contains { added.contains($0.id) && $0.level == .error } ? .error : nil
        }
    }
}

private extension ToastLevel {
    var icon: ImageResource? {
        switch self {
        case .error, .warning: .circleAlert
        case .success: .circleCheck
        case .info: nil
        }
    }

    var tint: Color {
        switch self {
        case .error: .red
        case .warning: .orange
        case .success: .green
        case .info: .secondary
        }
    }
}

extension View {
    /// Draws the toast stack over this presented layer while it is the top
    /// one: a sheet would otherwise hide the only report of why an action
    /// in it didn't stick. Below a navigation bar.
    func hostsToasts(_ model: AppModel) -> some View {
        modifier(ToastHost(model: model))
    }

    /// Reads `message` out to VoiceOver when it appears or changes, the way
    /// a web `role=alert` region does.
    func announces(_ message: String?) -> some View {
        onChange(of: message, initial: true) { _, new in
            if let new { UIAccessibility.post(notification: .announcement, argument: new) }
        }
    }
}

private struct ToastHost: ViewModifier {
    let model: AppModel
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if model.toastHosts.last == id {
                    ToastStack(model: model).padding(.top, 64)
                }
            }
            .onAppear { if !model.toastHosts.contains(id) { model.toastHosts.append(id) } }
            .onDisappear { model.toastHosts.removeAll { $0 == id } }
    }
}

/// The problem with one input, under it: red, announced.
struct FieldError: View {
    let message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .announces(message)
        }
    }
}
