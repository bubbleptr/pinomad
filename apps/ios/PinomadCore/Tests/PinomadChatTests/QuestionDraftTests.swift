import Testing
@testable import PinomadChat
import PinomadCore

@Suite struct QuestionDraftTests {
    @Test func singleChoiceReplacesThePick() {
        var draft = QuestionDraft(questionCount: 2)
        draft.pick(question: 0, option: "A", multiSelect: false)
        draft.pick(question: 0, option: "B", multiSelect: false)
        #expect(draft.selections[0] == ["B"])
        #expect(draft.selections[1].isEmpty)
    }

    @Test func multiChoiceTogglesEachOption() {
        var draft = QuestionDraft(questionCount: 1)
        draft.pick(question: 0, option: "A", multiSelect: true)
        draft.pick(question: 0, option: "B", multiSelect: true)
        draft.pick(question: 0, option: "A", multiSelect: true)
        #expect(draft.selections[0] == ["B"])
    }

    /// A request whose question list grew or shrank (host re-sent it) must
    /// not crash or misattribute: out-of-range picks are ignored.
    @Test func outOfRangeQuestionIsIgnored() {
        var draft = QuestionDraft(questionCount: 1)
        draft.pick(question: 3, option: "A", multiSelect: false)
        draft.setOther(question: 3, "x")
        #expect(draft.selections == [[]])
        #expect(draft.others == [""])
    }

    /// Untouched questions go out as skipped; blank "other" text is dropped
    /// (the core's questionAnswers rules).
    @Test func answersCarryPicksAndOtherText() {
        var draft = QuestionDraft(questionCount: 2)
        draft.pick(question: 0, option: "A", multiSelect: false)
        draft.setOther(question: 1, "自己写的")
        let answers = draft.answers()
        #expect(answers.count == 2)
        #expect(answers[0].selected == ["A"])
        #expect(answers[1].other == "自己写的")
    }
}
