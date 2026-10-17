import PinomadCore
import SwiftUI

/// Pick the shown conversation's model and thinking level. Changes go to
/// the host straight away; the sheet reads the agent state back from the
/// snapshot, so a refused change simply doesn't stick (and toasts).
struct ModelSheet: View {
    let model: AppModel
    let agent: AgentState

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var models: [ModelSummary] { model.snapshot?.models ?? [] }

    /// Offline changes "succeed" into a notice only — don't offer them.
    private var connected: Bool {
        guard let snapshot = model.snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    /// Live agent state when the conversation is still shown, else what
    /// the sheet opened with.
    private var current: AgentState { model.snapshot?.conversation?.agent ?? agent }

    private var levels: [ThinkingLevel] {
        summaryOf(models: models, model: current.model)?.thinkingLevels ?? []
    }

    var body: some View {
        NavigationStack {
            List {
                if levels.count > 1, query.isEmpty {
                    Section("思考等级") {
                        let selected = clampLevel(levels: levels, want: current.thinkingLevel ?? .off)
                        ForEach(levels, id: \.self) { level in
                            Button {
                                model.setThinkingLevel(level)
                                dismiss()
                            } label: {
                                Row(title: thinkingLevelLabel(level: level) ?? "\(level)", subtitle: nil,
                                    checked: level == selected)
                            }
                        }
                    }
                }
                Section("模型") {
                    ForEach(filterModels(models: models, query: query), id: \.self) { summary in
                        Button {
                            pick(summary)
                        } label: {
                            Row(title: summary.name ?? summary.modelId, subtitle: summary.provider,
                                checked: sameModel(a: ModelRef(provider: summary.provider, modelId: summary.modelId),
                                                   b: current.model))
                        }
                    }
                }
            }
            .tint(.primary)
            .disabled(!connected)
            .searchable(text: $query, prompt: "搜索模型")
            .navigationTitle("模型")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        // Below the sheet's own navigation bar.
        .overlay(alignment: .top) { ToastStack(model: model).padding(.top, 64) }
        .onAppear { model.sheetShowsToasts = true }
        .onDisappear { model.sheetShowsToasts = false }
        .presentationDetents([.medium, .large])
    }

    /// A reasoning model keeps the sheet up for the level pick; anything
    /// else is done.
    private func pick(_ summary: ModelSummary) {
        let ref = ModelRef(provider: summary.provider, modelId: summary.modelId)
        if !sameModel(a: ref, b: current.model) { model.setModel(ref) }
        query = ""
        if summary.thinkingLevels.count <= 1 { dismiss() }
    }
}

private struct Row: View {
    let title: String
    let subtitle: String?
    let checked: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(.primary)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if checked {
                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
            }
        }
        .contentShape(.rect)
    }
}
