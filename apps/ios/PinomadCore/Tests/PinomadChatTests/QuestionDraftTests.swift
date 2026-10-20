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

    /// Tapping the picked option again takes the answer back.
    @Test func singleChoiceRepickClears() {
        var draft = QuestionDraft(questionCount: 1)
        draft.pick(question: 0, option: "A", multiSelect: false)
        draft.pick(question: 0, option: "A", multiSelect: false)
        #expect(draft.selections[0].isEmpty)
        #expect(!draft.isAnswered(question: 0))
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
        draft.toggleOther(question: 1, multiSelect: false)
        draft.setOther(question: 1, "自己写的")
        let answers = draft.answers()
        #expect(answers.count == 2)
        #expect(answers[0].selected == ["A"])
        #expect(answers[1].other == "自己写的")
    }

    /// On a single-choice question Other is one more exclusive row: picking
    /// it drops the option, picking an option turns it off.
    @Test func singleChoiceOtherIsExclusive() {
        var draft = QuestionDraft(questionCount: 1)
        draft.pick(question: 0, option: "A", multiSelect: false)
        draft.toggleOther(question: 0, multiSelect: false)
        #expect(draft.selections[0].isEmpty)
        #expect(draft.isOtherOn(question: 0))
        draft.pick(question: 0, option: "B", multiSelect: false)
        #expect(draft.selections[0] == ["B"])
        #expect(!draft.isOtherOn(question: 0))
    }

    @Test func multiChoiceOtherCombines() {
        var draft = QuestionDraft(questionCount: 1)
        draft.pick(question: 0, option: "A", multiSelect: true)
        draft.toggleOther(question: 0, multiSelect: true)
        draft.setOther(question: 0, "还有这个")
        draft.pick(question: 0, option: "B", multiSelect: true)
        #expect(draft.isOtherOn(question: 0))
        let answer = draft.answers()[0]
        #expect(answer.selected == ["A", "B"])
        #expect(answer.other == "还有这个")
    }

    /// Other's text goes out only while its row is picked; turning it off
    /// keeps the text for when it is picked again.
    @Test func otherTextCountsOnlyWhilePicked() {
        var draft = QuestionDraft(questionCount: 1)
        draft.toggleOther(question: 0, multiSelect: false)
        draft.setOther(question: 0, "自己写的")
        #expect(draft.isAnswered(question: 0))
        draft.toggleOther(question: 0, multiSelect: false)
        #expect(!draft.isAnswered(question: 0))
        #expect(draft.answers()[0].other == nil)
        #expect(draft.others[0] == "自己写的")
    }

    /// Picked Other with blank text is not an answer yet.
    @Test func blankOtherIsUnanswered() {
        var draft = QuestionDraft(questionCount: 1)
        draft.toggleOther(question: 0, multiSelect: false)
        draft.setOther(question: 0, "  ")
        #expect(!draft.isAnswered(question: 0))
    }
}
