import PinomadChat
import PinomadCore
import SwiftUI

/// The named agent part of the model panel (ADR-0023). A role is a preset
/// of model, thinking level and system prompt, so it is picked here.
enum ModelPanelAgent {
    /// No agent plus the host's roles; a role that can't be picked stays
    /// listed with its reason.
    case pick(rows: [AgentPickRow], onSelect: (String?) -> Void)
    /// A conversation on a host that cannot switch (or a subagent): fixed.
    case fixed(name: String, description: String?)
}

/// The model button's panel: agent, model and thinking level on one
/// surface, each one tap away. Used for the shown conversation (the
/// callbacks call the host; the selection reads back from the snapshot, so
/// a refused change doesn't stick) and for the new-conversation draft (the
/// callbacks set the local pick). Sides the agent pins are shown but locked.
struct ModelPanel: View {
    static let width: CGFloat = 340

    let model: AppModel
    let models: [ModelSummary]
    let selected: ModelPick
    /// Nil hides the Agent section.
    var agent: ModelPanelAgent? = nil
    var lock: ModelLock = .none
    /// The draft's create is in flight and already took the pick.
    var locked = false
    let onModel: (ModelRef) -> Void
    let onLevel: (ThinkingLevel) -> Void

    @Environment(\.dismiss) private var dismiss
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44

    /// Offline changes "succeed" into a notice only — don't offer them.
    private var enabled: Bool { model.connected && !locked }

    private var levels: [ThinkingLevel] {
        summaryOf(models: models, model: selected.model)?.thinkingLevels ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let agent {
                agentSection(agent)
            }
            if !models.isEmpty {
                modelSection
            }
            if levels.count > 1 {
                levelSection
            }
        }
        .padding(.vertical, 18)
        .frame(width: Self.width, alignment: .leading)
        .tint(.primary)
        .hostsToasts(model)
    }

    // MARK: Agent

    @ViewBuilder
    private func agentSection(_ agent: ModelPanelAgent) -> some View {
        switch agent {
        case let .pick(rows, onSelect):
            section("Agent") {
                ChipRow {
                    ForEach(rows) { row in
                        Chip(title: Self.title(row), selected: row.selected, warning: !row.available,
                             enabled: enabled && row.available) {
                            if !row.selected { onSelect(row.name) }
                        }
                        .accessibilityHint(row.available ? (row.detail ?? "") : (row.detail ?? "Unavailable"))
                    }
                }
                if let detail = rows.first(where: \.selected).flatMap({ $0.available ? $0.detail : nil }) {
                    note(detail)
                }
                ForEach(rows.filter { !$0.available }) { row in
                    note("\(Self.title(row)): \(row.detail ?? "Unavailable")", warning: true)
                }
            }
        case let .fixed(name, description):
            section("Agent") {
                ChipRow {
                    Chip(title: "@\(name)", selected: true, enabled: false) {}
                }
                note([description.flatMap { $0.isEmpty ? nil : $0 }, "Set when the conversation was created."]
                    .compactMap { $0 }.joined(separator: " "))
            }
        }
    }

    private static func title(_ row: AgentPickRow) -> String {
        row.name.map { "@\($0)" } ?? "No agent"
    }

    // MARK: Model

    /// The models in the host's order, a divider wherever the provider
    /// changes.
    private var modelSection: some View {
        section("Model", lockedBy: lock.model ? lock.agent : nil) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(models.enumerated()), id: \.offset) { index, summary in
                            if index > 0, models[index - 1].provider != summary.provider {
                                Divider().padding(.horizontal, 18).padding(.vertical, 4)
                            }
                            modelRow(summary).id(index)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(listHeight, rowHeight * 6.5))
                .onAppear {
                    if let index = models.firstIndex(where: { isSelected($0) }) {
                        proxy.scrollTo(index, anchor: .center)
                    }
                }
            }
        }
    }

    private var listHeight: CGFloat {
        let dividers = zip(models, models.dropFirst()).filter { $0.provider != $1.provider }.count
        return CGFloat(models.count) * rowHeight + CGFloat(dividers) * 9
    }

    private func isSelected(_ summary: ModelSummary) -> Bool {
        sameModel(a: ModelRef(provider: summary.provider, modelId: summary.modelId), b: selected.model)
    }

    private func modelRow(_ summary: ModelSummary) -> some View {
        let ref = ModelRef(provider: summary.provider, modelId: summary.modelId)
        let checked = isSelected(summary)
        return Button {
            pick(summary)
        } label: {
            HStack(spacing: 10) {
                ModelLogo(model: ref, size: 20, reserve: true)
                Text(summary.name ?? summary.modelId)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if checked {
                    Image(.check).font(.body.weight(.semibold))
                }
            }
            .foregroundStyle(lock.model && !checked ? .tertiary : .primary)
            .padding(.horizontal, 18)
            .frame(minHeight: rowHeight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!enabled || lock.model)
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    /// A model with levels keeps the panel up for the level; anything else
    /// is done.
    private func pick(_ summary: ModelSummary) {
        let ref = ModelRef(provider: summary.provider, modelId: summary.modelId)
        if !sameModel(a: ref, b: selected.model) { onModel(ref) }
        if summary.thinkingLevels.count <= 1 || lock.level { dismiss() }
    }

    // MARK: Thinking

    private var levelSection: some View {
        let current = clampLevel(levels: levels, want: selected.level)
        return section("Thinking", lockedBy: lock.level ? lock.agent : nil) {
            ChipRow {
                ForEach(levels, id: \.self) { level in
                    Chip(title: thinkingLevelLabel(level: level) ?? "\(level)", selected: level == current,
                         enabled: enabled && !lock.level) {
                        if level != current { onLevel(level) }
                        dismiss()
                    }
                }
            }
        }
    }

    // MARK: Parts

    private func section<Content: View>(_ title: String, lockedBy agent: String? = nil,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Text(title).fontWeight(.semibold)
                Spacer(minLength: 8)
                if let agent {
                    Image(.lock).accessibilityHidden(true)
                    Text("Set by @\(agent)")
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 18)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func note(_ text: String, warning: Bool = false) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(warning ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 18)
    }
}

/// A row of chips that scrolls sideways when it outgrows the panel.
private struct ChipRow<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) { content }
                .padding(.horizontal, 18)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

/// One choice in a chip row: filled when selected, a warning glyph when it
/// can't be picked.
private struct Chip: View {
    let title: String
    let selected: Bool
    var warning = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if warning {
                    Image(.triangleAlert).foregroundStyle(.red)
                }
                Text(title).lineLimit(1)
            }
            .font(.subheadline.weight(selected ? .semibold : .regular))
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(background, in: .capsule)
        }
        .buttonStyle(.press)
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var foreground: AnyShapeStyle {
        if selected { return AnyShapeStyle(Color(uiColor: .systemBackground)) }
        return enabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary)
    }

    /// A locked choice keeps its place but loses its fill, so the row reads
    /// as set rather than offered.
    private var background: AnyShapeStyle {
        if selected { return AnyShapeStyle(Color(uiColor: .label)) }
        return enabled ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.fill.quinary)
    }
}

/// A model's logo (its maker's, else its provider's) as a bare glyph;
/// monochrome logos take the foreground style like text. Decorative: the
/// name is always beside it or in the surrounding control's label. With no logo it draws nothing,
/// or an empty slot of the same size when `reserve` keeps a list's titles
/// aligned.
struct ModelLogo: View {
    let model: ModelRef
    var size: CGFloat = 16
    var reserve = false

    var body: some View {
        if let asset = modelLogoAsset(model) {
            Image(asset)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else if reserve {
            Color.clear.frame(width: size, height: size)
        }
    }
}
