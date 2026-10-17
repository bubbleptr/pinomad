import PinomadCore

/// The reader's in-progress answers to one pending question request:
/// a pick list and an "other" text per question. Submitting goes through
/// the core's `questionAnswers`, which skips untouched questions and drops
/// blank "other" text.
public struct QuestionDraft: Equatable, Sendable {
    public private(set) var selections: [[String]]
    public private(set) var others: [String]

    public init(questionCount: Int) {
        selections = Array(repeating: [], count: questionCount)
        others = Array(repeating: "", count: questionCount)
    }

    /// Single choice replaces the pick; multi choice toggles the option.
    public mutating func pick(question: Int, option: String, multiSelect: Bool) {
        guard selections.indices.contains(question) else { return }
        if !multiSelect {
            selections[question] = [option]
        } else if let at = selections[question].firstIndex(of: option) {
            selections[question].remove(at: at)
        } else {
            selections[question].append(option)
        }
    }

    public mutating func setOther(question: Int, _ text: String) {
        guard others.indices.contains(question) else { return }
        others[question] = text
    }

    public func isPicked(question: Int, option: String) -> Bool {
        selections.indices.contains(question) && selections[question].contains(option)
    }

    public func answers() -> [QuestionAnswer] {
        questionAnswers(questionCount: UInt64(selections.count), selections: selections, others: others)
    }
}
