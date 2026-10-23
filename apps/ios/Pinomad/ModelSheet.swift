import PinomadChat
import PinomadCore
import SwiftUI

/// The named agent part of the model sheet (ADR-0023). A role is a preset
/// of model, thinking level and system prompt, so it is picked here.
enum ModelSheetAgent {
    /// No Agent plus the host's roles. `hint` says which sides still come
    /// from the role. A row the host no longer offers stays checked but is
    /// shown unavailable and cannot be picked again.
    case pick(rows: [AgentPickRow], hint: String?, onSelect: (String?) -> Void)
    /// A conversation on a host that cannot switch (or a subagent): fixed.
    case fixed(name: String, description: String?)
}

/// Pick a model and thinking level. Used for the shown conversation (the
/// callbacks call the host; the selection reads back from the snapshot, so
/// a refused change doesn't stick) and for the new-conversation draft (the
/// callbacks set the local pick).
struct ModelSheet: View {
    let model: AppModel
    let models: [ModelSummary]
    let selected: ModelPick
    /// Nil hides the Agent section.
    var agent: ModelSheetAgent? = nil
    /// The draft's create is in flight and already took the agent, model
    /// and level: a pick now would be dropped when the draft resets.
    var locked = false
    let onModel: (ModelRef) -> Void
    let onLevel: (ThinkingLevel) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    /// Offline changes "succeed" into a notice only — don't offer them.
    private var connected: Bool { model.connected }

    private var levels: [ThinkingLevel] {
        summaryOf(models: models, model: selected.model)?.thinkingLevels ?? []
    }

    var body: some View {
        NavigationStack {
            List {
                if let agent, query.isEmpty {
                    agentSection(agent)
                }
                if levels.count > 1, query.isEmpty {
                    Section("Thinking Level") {
                        let current = clampLevel(levels: levels, want: selected.level)
                        ForEach(levels, id: \.self) { level in
                            Button {
                                onLevel(level)
                                dismiss()
                            } label: {
                                Row(title: thinkingLevelLabel(level: level) ?? "\(level)", subtitle: nil,
                                    checked: level == current)
                            }
                        }
                    }
                }
                Section("Models") {
                    ForEach(filterModels(models: models, query: query), id: \.self) { summary in
                        Button {
                            pick(summary)
                        } label: {
                            Row(title: summary.name ?? summary.modelId, subtitle: summary.provider,
                                checked: sameModel(a: ModelRef(provider: summary.provider, modelId: summary.modelId),
                                                   b: selected.model))
                        }
                    }
                }
            }
            .tint(.primary)
            .disabled(!connected || locked)
            .searchable(text: $query, prompt: "Search models")
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // Below the sheet's own navigation bar.
        .overlay(alignment: .top) { ToastStack(model: model).padding(.top, 64) }
        .onAppear { model.sheetShowsToasts = true }
        .onDisappear { model.sheetShowsToasts = false }
        .presentationDetents([.medium, .large])
    }

    /// Picking a role keeps the sheet up: its model and level rows move to
    /// the preset, which the reader may still override.
    @ViewBuilder
    private func agentSection(_ agent: ModelSheetAgent) -> some View {
        switch agent {
        case let .pick(rows, hint, onSelect):
            Section {
                ForEach(rows) { row in
                    if row.available {
                        Button {
                            onSelect(row.name)
                        } label: {
                            Row(title: Self.title(row), subtitle: row.detail,
                                checked: row.selected)
                        }
                    } else {
                        Row(title: Self.title(row), subtitle: "Unavailable on this host",
                            checked: row.selected, available: false)
                    }
                }
            } header: {
                Text("Agent")
            } footer: {
                if let hint { Text(hint) }
            }
        case let .fixed(name, description):
            Section {
                Row(title: "@\(name)", subtitle: description.flatMap { $0.isEmpty ? nil : $0 },
                    checked: false)
            } header: {
                Text("Agent")
            } footer: {
                Text("Set when the conversation was created.")
            }
        }
    }

    private static func title(_ row: AgentPickRow) -> String {
        row.name.map { "@\($0)" } ?? "No Agent"
    }

    /// A reasoning model keeps the sheet up for the level pick; anything
    /// else is done.
    private func pick(_ summary: ModelSummary) {
        let ref = ModelRef(provider: summary.provider, modelId: summary.modelId)
        if !sameModel(a: ref, b: selected.model) { onModel(ref) }
        query = ""
        if summary.thinkingLevels.count <= 1 { dismiss() }
    }
}

private struct Row: View {
    let title: String
    let subtitle: String?
    let checked: Bool
    /// False mutes the row: it is shown but not a button.
    var available = true

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(available ? Color.primary : Color.secondary)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if checked {
                Image(.check)
                    .foregroundStyle(available ? Color.accentColor : Color.secondary)
            }
        }
        .contentShape(.rect)
    }
}
