import PinomadChat
import PinomadCore
import SwiftUI

/// Pending `ask_user_question` requests, above the composer so the agent's
/// question can't be missed. One card per request that pages through its
/// questions — swipe, the segments under it, Back, or a tap on a
/// single-choice option, which moves on by itself. One Submit sends every
/// question's answers at once; untouched questions count as skipped.
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

/// Solid label color: `Color.primary` turns into a vibrant gray on glass.
private let ink = Color(uiColor: .label)

/// Long enough for a tap to visibly land before the page moves.
private let advanceDelay = Duration.milliseconds(250)

private enum FooterAction { case submit, next, skip }

private struct QuestionCard: View {
    let model: AppModel
    let conversationId: UInt64
    let question: PendingQuestion
    let connected: Bool

    /// The question in view; the paging scroll view keeps it in sync.
    @State private var page: Int? = 0
    /// Scroll offset in pages (1.5 = halfway from the second to the third).
    @State private var position: CGFloat = 0
    @State private var pageHeights: [Int: CGFloat] = [:]
    @State private var scrolling = false
    /// Off for the first layout, so the card doesn't ease in from the
    /// tallest page's height.
    @State private var settled = false
    @State private var advance: Task<Void, Never>?
    /// While a pick's move is pending the footer keeps the action it showed
    /// before the pick, so it changes once (on the new page), not Skip →
    /// Next → Skip.
    @State private var heldAction: FooterAction?
    @State private var sending = false
    @FocusState private var otherFocus: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

    private var action: FooterAction {
        let allAnswered = (0..<count).allSatisfy { draft.isAnswered(question: $0) }
        if current == count - 1 || allAnswered { return .submit }
        return draft.isAnswered(question: current) ? .next : .skip
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            pager
            footer
        }
        .padding(16)
        // The composer's corners; 26 − 16 keeps the 10pt field corners concentric.
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .task { settled = true }
        .onDisappear { advance?.cancel() }
    }

    // MARK: Pager

    /// Every page is laid out at its own height; the pager shows as much as
    /// the page in view needs, blended by scroll progress mid-swipe so the
    /// card resizes with the finger. A jump or Other's field opening eases.
    private var pager: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(request.questions.enumerated()), id: \.offset) { index, item in
                    questionPage(index, item)
                        .padding(.horizontal, 16)
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                            pageHeights[index] = $0
                        }
                        .containerRelativeFrame(.horizontal)
                        .accessibilityHidden(index != current)
                        .id(index)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollIndicators(.hidden)
        .scrollPosition(id: $page)
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            let width = geometry.containerSize.width
            return width > 0 ? (geometry.contentOffset.x + geometry.contentInsets.leading) / width : 0
        } action: { _, now in
            position = now
        }
        .onScrollPhaseChange { _, phase in
            scrolling = phase.isScrolling
            // A finger dragging the pager overrides a pick's pending move at
            // once, before the page index changes. `go`'s own slide is
            // `.animating`, and a tap never gets past `.tracking`, so neither
            // cancels it.
            if phase == .interacting { cancelAdvance() }
        }
        .onChange(of: page) { _, _ in
            // A swipe overrides a pick's pending move, and leaves the field it was typing in.
            cancelAdvance()
            if otherFocus != current { otherFocus = nil }
        }
        // The scroll view is as tall as the tallest page; only the part
        // the current page needs shows and takes touches.
        .fixedSize(horizontal: false, vertical: true)
        .animation(heightAnimation) { $0.frame(height: pagerHeight, alignment: .top) }
        .clipped()
        .contentShape(.rect)
        // Pages bleed to the card edge, so a swipe slides them out under it.
        .padding(.horizontal, -16)
    }

    private var pagerHeight: CGFloat? {
        let at = min(max(position, 0), CGFloat(max(count - 1, 0)))
        let lower = Int(at.rounded(.down))
        guard let a = pageHeights[lower], let b = pageHeights[min(lower + 1, count - 1)] else { return nil }
        return a + (b - a) * (at - CGFloat(lower))
    }

    /// Mid-scroll the height follows the offset frame by frame; otherwise
    /// (a far jump, Other opening) it eases like the web card.
    private var heightAnimation: Animation? {
        guard settled, !scrolling, !reduceMotion else { return nil }
        return .timingCurve(0.32, 0.72, 0, 1, duration: 0.28)
    }

    /// One question: the question as the page's heading, its options, and
    /// Other as the last option row whose field opens under it.
    private func questionPage(_ index: Int, _ item: QuestionItem) -> some View {
        let multi = item.multiSelect == true
        let otherOn = draft.isOtherOn(question: index)
        return VStack(alignment: .leading, spacing: 0) {
            // Further from the first option than options sit from each other.
            Text(item.question)
                .font(.body.weight(.medium))
                .foregroundStyle(ink)
                .padding(.bottom, 7)
            ForEach(item.options, id: \.label) { option in
                OptionRow(
                    label: option.label,
                    description: option.description,
                    multi: multi,
                    picked: draft.isPicked(question: index, option: option.label)
                ) {
                    pick(index, item, option)
                }
            }
            OptionRow(label: "其他", description: nil, multi: multi, picked: otherOn) {
                toggleOther(index, multi: multi)
            }
            if otherOn {
                TextField("你的回答…", text: Binding(
                    get: { draft.others.indices.contains(index) ? draft.others[index] : "" },
                    set: { text in update { $0.setOther(question: index, text) } }
                ))
                .focused($otherFocus, equals: index)
                .submitLabel(index + 1 < count ? .next : .send)
                .onSubmit { index + 1 < count ? move(to: index + 1) : submit() }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.fill.tertiary, in: .rect(cornerRadius: 10))
                .padding(.leading, OptionRow.labelInset)
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 12) {
            // Equal-width sides keep the segments centred; an empty side
            // still has to take its share, which a Group would not.
            HStack {
                if current > 0 {
                    Button("上一题") { move(to: current - 1) }
                        .buttonStyle(CardButtonStyle(kind: .plain))
                        // The word lines up with the question, not its padding.
                        .padding(.leading, -CardButtonStyle.plainInset)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if count > 1 {
                Segments(
                    headers: request.questions.map(\.header),
                    current: current,
                    answered: { draft.isAnswered(question: $0) },
                    select: { move(to: $0) }
                )
            }
            HStack {
                switch heldAction ?? action {
                case .submit:
                    Button("提交", action: submit)
                        .buttonStyle(CardButtonStyle(kind: .primary))
                        .disabled(!connected || sending)
                case .next:
                    Button("下一题") { move(to: current + 1) }
                        .buttonStyle(CardButtonStyle(kind: .secondary))
                case .skip:
                    Button("跳过") { move(to: current + 1) }
                        .buttonStyle(CardButtonStyle(kind: .plain))
                        .padding(.trailing, -CardButtonStyle.plainInset)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    // MARK: Actions

    /// A single-choice tap moves on by itself, unless it took the answer
    /// back or this is the last question.
    private func pick(_ index: Int, _ item: QuestionItem, _ option: QuestionOption) {
        let multi = item.multiSelect == true
        let shown = heldAction ?? action
        let takesBack = draft.isPicked(question: index, option: option.label)
        update { $0.pick(question: index, option: option.label, multiSelect: multi) }
        cancelAdvance()
        guard !multi, !takesBack, index + 1 < count else { return }
        heldAction = shown
        advance = Task {
            if !reduceMotion { try? await Task.sleep(for: advanceDelay) }
            guard !Task.isCancelled else { return }
            advance = nil
            go(to: index + 1)
            heldAction = nil
        }
    }

    /// Picking Other means "I want to type": its field takes focus.
    private func toggleOther(_ index: Int, multi: Bool) {
        cancelAdvance()
        update { $0.toggleOther(question: index, multiSelect: multi) }
        if draft.isOtherOn(question: index) {
            // The field appears in this update; focus it once it exists.
            Task { otherFocus = index }
        } else if otherFocus == index {
            otherFocus = nil
        }
    }

    /// Any move the person makes overrides a pick's pending one.
    private func move(to target: Int) {
        cancelAdvance()
        go(to: target)
    }

    private func cancelAdvance() {
        advance?.cancel()
        advance = nil
        heldAction = nil
    }

    /// A neighbour slides; a farther jump cuts straight to the page (the
    /// height still eases), so it never sweeps through the pages between.
    private func go(to target: Int) {
        let next = min(max(target, 0), count - 1)
        guard next != current else { return }
        if reduceMotion || abs(next - current) > 1 {
            var cut = Transaction()
            cut.disablesAnimations = true
            withTransaction(cut) { page = next }
        } else {
            withAnimation(Motion.settle) { page = next }
        }
    }

    /// Held while the host takes the answer, so a double tap sends once. A
    /// refusal resolves normally (toasted) and Submit comes back; success
    /// resolves the request and the card goes away.
    private func submit() {
        guard connected, !sending else { return }
        cancelAdvance()
        otherFocus = nil
        sending = true
        Task {
            await model.answer(question, conversation: conversationId)
            sending = false
        }
    }
}

/// One small bar per question under the pages: answered ones solid, the
/// current unanswered one half-tone. Tapping one jumps to that question.
private struct Segments: View {
    let headers: [String]
    let current: Int
    let answered: (Int) -> Bool
    let select: (Int) -> Void

    private var count: Int { headers.count }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(fill(index))
                    .frame(width: 24, height: 4)
                    // A 4pt bar is no target: the hit area is the bar's slot.
                    .padding(.horizontal, 2)
                    .frame(height: 34)
                    .contentShape(.rect)
                    .onTapGesture { select(index) }
            }
        }
        .animation(.easeOut(duration: 0.2), value: current)
        .accessibilityElement()
        .accessibilityLabel("第 \(current + 1) 题，共 \(count) 题，\(headers[current])")
        .accessibilityValue(answered(current) ? "已回答" : "未回答")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: select(min(current + 1, count - 1))
            case .decrement: select(max(current - 1, 0))
            @unknown default: break
            }
        }
    }

    private func fill(_ index: Int) -> Color {
        if answered(index) { return ink }
        return ink.opacity(index == current ? 0.35 : 0.12)
    }
}

private struct OptionRow: View {
    let label: String
    let description: String?
    let multi: Bool
    let picked: Bool
    let action: () -> Void

    /// Where the label column starts: the glyph's width plus the gap.
    static let labelInset: CGFloat = 26

    private var icon: ImageResource {
        switch (multi, picked) {
        case (true, true): .squareCheck
        case (true, false): .square
        case (false, true): .circleDot
        case (false, false): .circle
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(icon)
                    .font(.subheadline)
                    .foregroundStyle(picked ? Color.accentColor : .secondary)
                    .frame(width: Self.labelInset - 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.callout)
                        .foregroundStyle(ink)
                    if let description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            // The rows' own padding is the gap between them, so the whole
            // stretch is tappable without hit areas overlapping.
            .padding(.vertical, 5)
            .contentShape(.rect)
        }
        .buttonStyle(.press)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }
}

/// The footer's buttons. Colors are concrete and follow `isEnabled`: a
/// prominent style tinted `.label` with a forced `.systemBackground` title
/// drew a disabled Submit as white on a pale fill, which vanished on glass.
private struct CardButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, plain }
    let kind: Kind

    /// A plain button's padding, which callers pull back so its word lines
    /// up with the card's content.
    static let plainInset: CGFloat = 8

    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(kind == .plain ? .regular : .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, kind == .plain ? Self.plainInset : 16)
            .frame(minHeight: 34)
            .background(background, in: .capsule)
            .contentShape(.capsule)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .sensoryFeedback(.impact(weight: .light), trigger: configuration.isPressed) { _, pressed in pressed }
    }

    private var foreground: Color {
        switch kind {
        case .primary: Color(uiColor: isEnabled ? .systemBackground : .tertiaryLabel)
        case .secondary: ink
        case .plain: Color(uiColor: .secondaryLabel)
        }
    }

    private var background: Color {
        switch kind {
        case .primary: isEnabled ? ink : Color(uiColor: .tertiarySystemFill)
        case .secondary: Color(uiColor: .tertiarySystemFill)
        case .plain: .clear
        }
    }
}
