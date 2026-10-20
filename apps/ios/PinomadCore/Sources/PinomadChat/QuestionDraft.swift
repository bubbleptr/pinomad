import PinomadCore

/// The reader's in-progress answers to one pending question request: a
/// pick list, an "other" text and whether the Other row is picked, per
/// question. Submitting goes through the core's `questionAnswers`, which
/// skips untouched questions and drops blank "other" text.
public struct QuestionDraft: Equatable, Sendable {
    public private(set) var selections: [[String]]
    public private(set) var others: [String]
    /// Other's text only counts while its row is picked; the text is kept
    /// while it isn't, for when it is picked again.
    public private(set) var otherOn: [Bool]

    public init(questionCount: Int) {
        selections = Array(repeating: [], count: questionCount)
        others = Array(repeating: "", count: questionCount)
        otherOn = Array(repeating: false, count: questionCount)
    }

    /// Single choice replaces the pick and turns Other off; picking the
    /// picked option again takes it back. Multi choice toggles the option.
    public mutating func pick(question: Int, option: String, multiSelect: Bool) {
        guard selections.indices.contains(question) else { return }
        if !multiSelect {
            selections[question] = selections[question] == [option] ? [] : [option]
            otherOn[question] = false
        } else if let at = selections[question].firstIndex(of: option) {
            selections[question].remove(at: at)
        } else {
            selections[question].append(option)
        }
    }

    /// Other is the last option row: exclusive on single choice (picking it
    /// drops the option), combinable on multi choice.
    public mutating func toggleOther(question: Int, multiSelect: Bool) {
        guard otherOn.indices.contains(question) else { return }
        otherOn[question].toggle()
        if otherOn[question], !multiSelect { selections[question] = [] }
    }

    public mutating func setOther(question: Int, _ text: String) {
        guard others.indices.contains(question) else { return }
        others[question] = text
    }

    public func isPicked(question: Int, option: String) -> Bool {
        selections.indices.contains(question) && selections[question].contains(option)
    }

    public func isOtherOn(question: Int) -> Bool {
        otherOn.indices.contains(question) && otherOn[question]
    }

    /// A pick, or a picked Other with text in it.
    public func isAnswered(question: Int) -> Bool {
        guard selections.indices.contains(question) else { return false }
        return !selections[question].isEmpty
            || (otherOn[question] && !others[question].allSatisfy(\.isWhitespace))
    }

    public func answers() -> [QuestionAnswer] {
        let sentOthers = others.indices.map { otherOn[$0] ? others[$0] : "" }
        return questionAnswers(questionCount: UInt64(selections.count), selections: selections, others: sentOthers)
    }
}
