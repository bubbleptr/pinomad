import PinomadChat
import PinomadCore
import SwiftUI

/// Pending `ask_user_question` requests, above the composer so the agent's
/// question can't be missed. One card per request; inside it one question
/// at a time, swiped sideways, so a long question set keeps the card short.
struct QuestionCards: View {
    let model: AppModel
    let conversationId: UInt64
    let questions: [PendingQuestion]
    let connected: Bool

    var body: some View {
        VStack(spacing: 8) {
            ForEach(questions, id: \.request.id) { question in
                QuestionCard(model: model, conversationId: conversationId,
                             question: question, connected: connected)
            }
        }
    }
}

private struct QuestionCard: View {
    let model: AppModel
    let conversationId: UInt64
    let question: PendingQuestion
    let connected: Bool

    /// The question in view; the paging scroll view keeps it in sync.
    @State private var page: Int? = 0

    private var request: QuestionRequest { question.request }
    private var count: Int { request.questions.count }
    private var current: Int { min(max(page ?? 0, 0), max(count - 1, 0)) }

    private var draft: QuestionDraft {
        model.questionDrafts[request.id] ?? QuestionDraft(questionCount: count)
    }

    private func update(_ change: (inout QuestionDraft) -> Void) {
        var next = draft
        change(&next)
        model.questionDrafts[request.id] = next
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Agent 在问", systemImage: "questionmark.bubble")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if count > 1 {
                    Text("第 \(current + 1)/\(count) 题")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            // All pages laid out (at most four questions), so the card takes
            // the tallest page's height and doesn't jump while swiping.
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 0) {
                    ForEach(Array(request.questions.enumerated()), id: \.offset) { index, item in
                        questionPage(index, item)
                            .containerRelativeFrame(.horizontal)
                            .id(index)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .scrollPosition(id: $page)
            HStack {
                if count > 1 {
                    PageIndicator(count: count, current: current) { index in
                        withAnimation(.snappy) { page = index }
                    }
                }
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

    private func questionPage(_ index: Int, _ item: QuestionItem) -> some View {
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
                    .fixedSize(horizontal: false, vertical: true)
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
}

/// One dot per question; the current one stretches into a bar. Tapping a
/// dot jumps to that question.
private struct PageIndicator: View {
    let count: Int
    let current: Int
    let select: (Int) -> Void

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == current ? Color.primary : Color.secondary.opacity(0.35))
                    .frame(width: index == current ? 18 : 6, height: 6)
                    .contentShape(.rect.inset(by: -6))
                    .onTapGesture { select(index) }
            }
        }
        .animation(.snappy, value: current)
        .accessibilityElement()
        .accessibilityLabel("第 \(current + 1) 题，共 \(count) 题")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: select(min(current + 1, count - 1))
            case .decrement: select(max(current - 1, 0))
            @unknown default: break
            }
        }
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
