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

/// The question card's records: a pending question without the request's
/// raw JSON, so they cross the FFI and sit in an Inbox task (5.41).
pub mod card {
    use crate::presentation::{QuestionItem, QuestionResolution};

    /// An unresolved `pinomad.question` request (ADR-0011) and the kind of the
    /// doc carrying it.
    #[derive(Clone, Debug, PartialEq)]
    #[cfg_attr(feature = "ffi", derive(uniffi::Record))]
    pub struct PendingQuestion {
        pub kind: String,
        pub request: QuestionRequest,
    }

    /// `QuestionRequest` without raw — the question card renders from this.
    #[derive(Clone, Debug, PartialEq)]
    #[cfg_attr(feature = "ffi", derive(uniffi::Record))]
    pub struct QuestionRequest {
        pub id: String,
        pub questions: Vec<QuestionItem>,
        /// Epoch ms the request was asked.
        pub asked_at: f64,
        /// Absent while the request is still open.
        pub resolution: Option<QuestionResolution>,
    }

    impl From<super::PendingQuestion> for PendingQuestion {
        fn from(pending: super::PendingQuestion) -> Self {
            Self { kind: pending.kind, request: pending.request.into() }
        }
    }

    impl From<crate::presentation::QuestionRequest> for QuestionRequest {
        fn from(request: crate::presentation::QuestionRequest) -> Self {
            Self { id: request.id, questions: request.questions, asked_at: request.asked_at, resolution: request.resolution }
        }
    }
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
