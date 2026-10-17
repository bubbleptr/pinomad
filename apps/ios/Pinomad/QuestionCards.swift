import PinomadChat
import PinomadCore
import SwiftUI

/// Pending `ask_user_question` requests, above the composer so the agent's
/// question can't be missed. Capped in height so a long question set never
/// pushes the input off screen.
struct QuestionCards: View {
    let model: AppModel
    let conversationId: UInt64
    let questions: [PendingQuestion]
    let connected: Bool

    /// The cards' natural height. A ScrollView takes whatever height it's
    /// offered (and its ideal is the full content), so it's sized by hand:
    /// the content, up to the cap.
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                ForEach(questions, id: \.request.id) { question in
                    QuestionCard(model: model, conversationId: conversationId,
                                 question: question, connected: connected)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(contentHeight, cap))
    }

    /// About 40% of the screen, so the input still fits above the keyboard.
    private var cap: CGFloat {
        let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.height ?? 800
        return screen * 0.4
    }
}

private struct QuestionCard: View {
    let model: AppModel
    let conversationId: UInt64
    let question: PendingQuestion
    let connected: Bool

    private var request: QuestionRequest { question.request }

    private var draft: QuestionDraft {
        model.questionDrafts[request.id] ?? QuestionDraft(questionCount: request.questions.count)
    }

    private func update(_ change: (inout QuestionDraft) -> Void) {
        var next = draft
        change(&next)
        model.questionDrafts[request.id] = next
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Agent 在问", systemImage: "questionmark.bubble")
                .font(.subheadline.weight(.semibold))
            ForEach(Array(request.questions.enumerated()), id: \.offset) { index, item in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if !item.header.isEmpty {
                            Text(item.header)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(.fill.tertiary, in: .capsule)
                        }
                        Text(item.question)
                            .font(.callout)
                    }
                    let multi = item.multiSelect == true
                    ForEach(item.options, id: \.label) { option in
                        OptionRow(
                            option: option,
                            multi: multi,
                            picked: draft.isPicked(question: index, option: option.label)
                        ) {
                            update { $0.pick(question: index, option: option.label, multiSelect: multi) }
                        }
                    }
                    TextField("其他…", text: Binding(
                        get: { draft.others.indices.contains(index) ? draft.others[index] : "" },
                        set: { text in update { $0.setOther(question: index, text) } }
                    ), axis: .vertical)
                    .lineLimit(1...4)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 10))
                }
            }
            HStack {
                Spacer()
                Button("提交") { model.answer(question, conversation: conversationId) }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(uiColor: .label))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .disabled(!connected)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

private struct OptionRow: View {
    let option: QuestionOption
    let multi: Bool
    let picked: Bool
    let action: () -> Void

    private var icon: String {
        switch (multi, picked) {
        case (true, true): "checkmark.square.fill"
        case (true, false): "square"
        case (false, true): "largecircle.fill.circle"
        case (false, false): "circle"
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: icon)
                    .foregroundStyle(picked ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).foregroundStyle(.primary)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }
}
