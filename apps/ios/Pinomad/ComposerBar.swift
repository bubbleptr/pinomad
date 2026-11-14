import PinomadChat
import PinomadCore
import SwiftUI

/// The composer's bottom row: two round glass controls (Add, then the
/// model and agent) beside the draft's field, all bottom-aligned so the
/// circles stay put while the field grows.
enum ComposerBar {
    /// The circles' diameter and the field's one-line height.
    static let controlSize: CGFloat = 48
    /// Half the control size: a one-line field reads as a capsule.
    static let cornerRadius: CGFloat = controlSize / 2
    static let spacing: CGFloat = 8
}

/// The draft's glass field: optional attachments and notes across the top,
/// then the text with the send slot at its trailing bottom corner.
struct ComposerField<Top: View, Draft: View, Trailing: View>: View {
    /// Whether `top` has anything to show; an empty top takes no room.
    let showsTop: Bool
    @ViewBuilder let top: Top
    @ViewBuilder let text: Draft
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showsTop {
                VStack(alignment: .leading, spacing: 8) { top }
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
            }
            HStack(alignment: .bottom, spacing: 4) {
                text
                    .padding(.leading, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing
                    .padding(7)
            }
        }
        .frame(minHeight: ComposerBar.controlSize)
        .glassEffect(.regular, in: .rect(cornerRadius: ComposerBar.cornerRadius))
    }
}

/// The round control that opens the model and agent picker. It shows the
/// model's logo (its first letter when there is none) and an `@` badge
/// while a named agent is set; the full pick is in its label and the
/// picker.
struct ModelButton: View {
    /// The model's full name and level, as VoiceOver reads it.
    let label: String
    /// The picked model, whose logo stands in for it.
    let logo: ModelRef?
    /// The named agent the pick comes from, without the `@`.
    let agent: String?
    let enabled: Bool
    /// Why the shown pick can't be sent: the button turns red.
    var problem: String? = nil
    let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var logoSize: CGFloat = 22

    var body: some View {
        Button(action: action) {
            mark
                .frame(width: ComposerBar.controlSize, height: ComposerBar.controlSize)
                .overlay(alignment: .bottomTrailing) { badge }
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(.press)
        .disabled(!enabled)
        .accessibilityLabel(problem.map { "Model: \($0)" }
            ?? "Model: \([agent.map { "@\($0)" }, label.isEmpty ? "Choose model" : label].compactMap { $0 }.joined(separator: " "))")
    }

    @ViewBuilder
    private var mark: some View {
        if problem != nil {
            Image(.triangleAlert)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.red)
        } else if let logo, modelLogoAsset(logo) != nil {
            ModelLogo(model: logo, size: logoSize)
                .foregroundStyle(.primary)
        } else {
            Text(Self.monogram(label))
                .font(.system(.headline, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var badge: some View {
        if agent != nil, problem == nil {
            Text(verbatim: "@")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color(uiColor: .systemBackground))
                .frame(minWidth: 18, minHeight: 18)
                .background(Color(uiColor: .label), in: .circle)
                .offset(x: 2, y: 2)
                .accessibilityHidden(true)
        }
    }

    /// The first letter of the model's name, for a model without a logo.
    static func monogram(_ label: String) -> String {
        label.first(where: \.isLetter).map { String($0).uppercased() } ?? "?"
    }
}
