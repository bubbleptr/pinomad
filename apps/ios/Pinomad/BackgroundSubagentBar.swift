import PinomadChat
import SwiftUI

/// The family's background subagents (ADR-0046), one at a time in a bar
/// that sits on the composer card and shares its glass and corners: who
/// it is and what it is on, then model, branch and position. Tapping it
/// opens the subagent; Stop halts the one shown while it works, Next
/// steps to the following one. The shown one is kept by id, so the list
/// reordering under it never swaps it for another.
struct BackgroundSubagentBar: View {
    let items: [BackgroundSubagent]
    let connected: Bool
    let open: (UInt64) -> Void
    let stop: (UInt64) -> Void

    @State private var selection = BackgroundSelection()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let index = selection.index(in: items) {
            let item = items[index]
            HStack(spacing: 0) {
                Button {
                    open(item.id)
                } label: {
                    HStack(spacing: 12) {
                        SubagentAvatar(working: item.working, failed: item.failed)
                        VStack(alignment: .leading, spacing: 2) {
                            title(item)
                            detail(item, index: index)
                        }
                        // All the width left, so a spacer can't take a share
                        // the lines then truncate for.
                        .frame(maxWidth: .infinity, alignment: .leading)
                        // A new subagent's lines replace the old ones in place.
                        .id(item.id)
                        .transition(.opacity)
                    }
                    .padding(.leading, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.press)
                .accessibilityLabel(accessibilityLabel(item))
                .accessibilityHint("Opens the subagent conversation")
                if item.working {
                    Button {
                        stop(item.id)
                    } label: {
                        // A solid square, as on the composer's Stop. Concrete
                        // colors: on glass `.primary` gets vibrancy and reads
                        // as a disabled grey.
                        RoundedRectangle(cornerRadius: 2.5)
                            .frame(width: 11, height: 11)
                            .foregroundStyle(Color(uiColor: connected ? .label : .tertiaryLabel))
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.press)
                    .disabled(!connected)
                    .accessibilityLabel("Stop \(item.name)")
                }
                if items.count > 1 {
                    Button {
                        withAnimation(reduceMotion ? nil : Motion.settle) { selection.next(items) }
                    } label: {
                        Image(.chevronsRight)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.press)
                    .accessibilityLabel("Next subagent")
                    .accessibilityValue("\(index + 1) of \(items.count)")
                }
            }
            .padding(.trailing, 6)
            .glassEffect(.regular, in: .rect(cornerRadius: ConversationComposer.cardCornerRadius))
            .onAppear { selection.sync(items) }
            .onChange(of: items.map(\.id)) { _, _ in selection.sync(items) }
        }
    }

    /// The name, then what it was dispatched to do.
    private func title(_ item: BackgroundSubagent) -> some View {
        var line = Text(item.name).fontWeight(.semibold)
        if let label = item.label {
            line = line + Text(" · \(label)").foregroundStyle(.secondary)
        }
        return line
            .font(.subheadline)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    /// Failed, model, branch, position. Each part truncates on its own: the
    /// position stays whole, and a long branch loses its middle, where
    /// `pinomad/` and the id at its ends say most.
    private func detail(_ item: BackgroundSubagent, index: Int) -> some View {
        let count = items.count > 1 ? "\(index + 1) of \(items.count)" : nil
        let parts: [(text: String, priority: Double, red: Bool)] = [
            item.failed ? ("Failed", 3, true) : nil,
            item.model.map { ($0, 1, false) },
            item.branch.map { ($0, 0, false) },
            count.map { ($0, 2, false) },
        ].compactMap { $0 }
        return HStack(spacing: 0) {
            ForEach(Array(parts.enumerated()), id: \.offset) { offset, part in
                if offset > 0 {
                    Text(" · ")
                        .foregroundStyle(.secondary)
                        .layoutPriority(4)
                }
                Text(part.text)
                    .foregroundStyle(part.red ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    .truncationMode(part.priority == 0 ? .middle : .tail)
                    .layoutPriority(part.priority)
            }
        }
        .font(.caption)
        .monospacedDigit()
        .lineLimit(1)
    }

    private func accessibilityLabel(_ item: BackgroundSubagent) -> String {
        let state = item.working ? "Working" : item.failed ? "Failed" : "Idle"
        return [item.name, item.label, state, item.model, item.branch].compactMap { $0 }.joined(separator: ", ")
    }
}

/// The subagent's mark: a tinted disc with a bot glyph that pulses while
/// it works (held still under Reduce Motion), with the status dot the
/// transcript cards use.
private struct SubagentAvatar: View {
    let working: Bool
    let failed: Bool

    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 34
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(.bot)
            .font(.system(size: size * 0.5, weight: .medium))
            .foregroundStyle(Color(uiColor: .systemIndigo))
            .symbolEffect(.pulse, options: .repeating, isActive: working && !reduceMotion)
            .frame(width: size, height: size)
            .background(Color(uiColor: .systemIndigo).opacity(0.14), in: .circle)
            .overlay(alignment: .bottomTrailing) {
                if working || failed {
                    Circle()
                        .fill(failed ? Color.red : Color.green)
                        .frame(width: 9, height: 9)
                        .overlay { Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2) }
                        .offset(x: 1, y: 1)
                }
            }
            .accessibilityHidden(true)
    }
}
