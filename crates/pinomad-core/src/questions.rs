// Pending `pinomad.question` requests (ADR-0011) from
// packages/client/src/questions.ts.
use crate::json::Json;
use crate::presentation::{classify, ClassifiedDoc, QuestionRequest};
use crate::text;

// Re-exported so the answer builder and the classified doc share one type.
pub use crate::presentation::QuestionAnswer;

/// One unresolved question request and the kind of the doc carrying it.
#[derive(Clone, Debug)]
pub struct PendingQuestion {
    pub kind: String,
    pub request: QuestionRequest,
}

/// `pendingQuestions`: the unresolved `pinomad.question` requests across
/// docs, in doc order.
pub fn pending_questions(docs: &[Json]) -> Vec<PendingQuestion> {
    let mut pending = Vec::new();
    for doc in docs {
        let value = doc.get("value").cloned().unwrap_or(Json::Null);
        let classified = classify(doc.get("presentation"), &value);
        let ClassifiedDoc::Question(question) = classified else {
            continue;
        };
        for request in &question.requests {
            if request.resolution.is_none() {
                pending.push(PendingQuestion {
                    kind: crate::u16str::U16String(text::string_of(doc.get("kind"))).to_string_lossy(),
                    request: request.clone(),
                });
            }
        }
    }
    pending
}

/// `questionAnswers`.
pub fn question_answers(question_count: usize, selections: &[Vec<String>], others: &[String]) -> Vec<QuestionAnswer> {
    (0..question_count)
        .map(|index| QuestionAnswer {
            selected: selections.get(index).cloned().unwrap_or_default(),
            other: others.get(index).filter(|o| !text::is_blank_str(o)).cloned(),
        })
        .collect()
}
