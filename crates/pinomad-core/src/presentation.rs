// The `classify` boundary from packages/protocol/src/presentation.ts: the
// declared presentation type plus a value that conforms to its schema gets
// the typed view; anything else — including a presentation a newer host
// invented — falls back. The schema checks below mirror typebox's
// Value.Check exactly: objects reject arrays and null, `minLength` counts
// code points (not UTF-16 units), and Type.Number rejects NaN and Infinity.
//
// The classified documents decode their schema-validated fields into owned
// records for the UI; each keeps the raw Json privately so it can still be
// handed through verbatim where the reference emits it whole.

use crate::json::Json;
use crate::u16str::U16String;

// ─── Typed documents ────────────────────────────────────────────────────────

/// `TodoItemSchema.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TodoStatus::Pending => "pending",
            TodoStatus::InProgress => "in_progress",
            TodoStatus::Completed => "completed",
        }
    }
}

/// `TodoItemSchema`: `{text: string(minLength: 1), status}`.
#[derive(Clone, Debug)]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

/// `TodoSchema`: `{items: TodoItem[]}`.
#[derive(Clone, Debug)]
pub struct TodoDoc {
    pub items: Vec<TodoItem>,
    raw: Json,
}

impl TodoDoc {
    /// The document as it arrived — the reference hands the value through.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// `QuestionOptionSchema`: `{label: string(minLength: 1), description?}`.
#[derive(Clone, Debug)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// `QuestionItemSchema`: `{question, header, options: 2..4, multiSelect?}`.
#[derive(Clone, Debug)]
pub struct QuestionItem {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: Option<bool>,
}

/// `QuestionAnswerSchema`: labels chosen from a question's options; empty
/// `selected` with no `other` means skipped.
#[derive(Clone, Debug)]
pub struct QuestionAnswer {
    pub selected: Vec<String>,
    pub other: Option<String>,
}

/// `QuestionResolutionSchema`.
#[derive(Clone, Debug)]
pub enum QuestionResolution {
    Answered { answers: Vec<QuestionAnswer>, at: f64 },
    /// The user replied in chat instead (ADR-0011 §4).
    Dismissed { at: f64 },
    Cancelled { at: f64 },
}

/// `QuestionRequestSchema`: `{id, questions: 1..4, askedAt, resolution?}`.
#[derive(Clone, Debug)]
pub struct QuestionRequest {
    pub id: String,
    pub questions: Vec<QuestionItem>,
    pub asked_at: f64,
    pub resolution: Option<QuestionResolution>,
    raw: Json,
}

impl QuestionRequest {
    /// The request object as it arrived — `pendingQuestions` emits it verbatim.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// `QuestionSchema`: `{requests: QuestionRequest[]}`.
#[derive(Clone, Debug)]
pub struct QuestionDoc {
    pub requests: Vec<QuestionRequest>,
    raw: Json,
}

impl QuestionDoc {
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// `DiffSchema`: `{patch: string}` — a unified patch (ADR-0005).
#[derive(Clone, Debug)]
pub struct DiffDoc {
    pub patch: String,
    raw: Json,
}

impl DiffDoc {
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// `CodemodeCallSchema.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodemodeCallStatus {
    Running,
    Ok,
    Error,
    Cancelled,
}

impl CodemodeCallStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CodemodeCallStatus::Running => "running",
            CodemodeCallStatus::Ok => "ok",
            CodemodeCallStatus::Error => "error",
            CodemodeCallStatus::Cancelled => "cancelled",
        }
    }
}

/// `CodemodeCallSchema` — a nested call the codemode script made (ADR-0013 §7).
/// `details` (a nested call's declared-presentation payload) stays in `raw`.
#[derive(Clone, Debug)]
pub struct CodemodeCall {
    /// The VM's call number.
    pub id: Option<u64>,
    pub name: String,
    /// Compact JSON of the arguments, summarized.
    pub args: String,
    pub status: CodemodeCallStatus,
    pub duration_ms: Option<f64>,
    pub error: Option<String>,
    raw: Json,
}

impl CodemodeCall {
    /// The call object verbatim, including `details` and any extra fields.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// `CodemodeSchema`: `{code?, calls: CodemodeCall[]}` — legacy entries carry
/// `code` and call `details`; upstream durable codemode writes `calls` once.
#[derive(Clone, Debug)]
pub struct CodemodeDoc {
    pub code: Option<String>,
    pub calls: Vec<CodemodeCall>,
    raw: Json,
}

impl CodemodeDoc {
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// The `fallback` value: an arbitrary document the UI renders generically.
#[derive(Clone, Debug)]
pub struct FallbackDoc {
    raw: Json,
}

impl FallbackDoc {
    /// The document verbatim — the fallback renderer works on the raw value.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// The wire tag the reference emits for each variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocType {
    Todo,
    Question,
    Diff,
    Codemode,
    Fallback,
}

impl DocType {
    pub fn as_str(self) -> &'static str {
        match self {
            DocType::Todo => "pinomad.todo",
            DocType::Question => "pinomad.question",
            DocType::Diff => "pinomad.diff",
            DocType::Codemode => "pinomad.codemode",
            DocType::Fallback => "fallback",
        }
    }
}

/// A tool-result `details` or extension document after `classify`.
#[derive(Clone, Debug)]
pub enum ClassifiedDoc {
    Todo(TodoDoc),
    Question(QuestionDoc),
    Diff(DiffDoc),
    Codemode(CodemodeDoc),
    Fallback(FallbackDoc),
}

impl ClassifiedDoc {
    /// `classified.type` — the wire tag the reference emits.
    pub fn doc_type(&self) -> DocType {
        match self {
            ClassifiedDoc::Todo(_) => DocType::Todo,
            ClassifiedDoc::Question(_) => DocType::Question,
            ClassifiedDoc::Diff(_) => DocType::Diff,
            ClassifiedDoc::Codemode(_) => DocType::Codemode,
            ClassifiedDoc::Fallback(_) => DocType::Fallback,
        }
    }

    /// `classified.value` — the document as it arrived.
    pub fn to_json(&self) -> Json {
        match self {
            ClassifiedDoc::Todo(d) => d.to_json(),
            ClassifiedDoc::Question(d) => d.to_json(),
            ClassifiedDoc::Diff(d) => d.to_json(),
            ClassifiedDoc::Codemode(d) => d.to_json(),
            ClassifiedDoc::Fallback(d) => d.to_json(),
        }
    }
}

// ─── Decoding (safe after the matching schema check) ────────────────────────

fn text(value: Option<&Json>) -> String {
    value.and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default()
}

fn decode_todo(value: &Json) -> TodoDoc {
    let items = value
        .get("items")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .map(|item| TodoItem {
                    text: text(item.get("text")),
                    status: match item.get("status").and_then(Json::as_str).map(|s| s.units()) {
                        Some(u) if u == U16String::from_str("in_progress").units() => TodoStatus::InProgress,
                        Some(u) if u == U16String::from_str("completed").units() => TodoStatus::Completed,
                        _ => TodoStatus::Pending,
                    },
                })
                .collect()
        })
        .unwrap_or_default();
    TodoDoc { items, raw: value.clone() }
}

fn decode_question_answer(value: &Json) -> QuestionAnswer {
    QuestionAnswer {
        selected: value
            .get("selected")
            .and_then(Json::as_array)
            .map(|list| list.iter().filter_map(|v| v.as_str().map(|s| s.to_string_lossy())).collect())
            .unwrap_or_default(),
        other: value.get("other").and_then(Json::as_str).map(|s| s.to_string_lossy()),
    }
}

fn decode_resolution(value: &Json) -> Option<QuestionResolution> {
    let at = value.get("at").and_then(Json::as_number).unwrap_or(f64::NAN);
    match value.get("outcome").and_then(Json::as_str).map(|s| s.units()) {
        Some(u) if u == U16String::from_str("answered").units() => Some(QuestionResolution::Answered {
            answers: value
                .get("answers")
                .and_then(Json::as_array)
                .map(|list| list.iter().map(decode_question_answer).collect())
                .unwrap_or_default(),
            at,
        }),
        Some(u) if u == U16String::from_str("dismissed").units() => Some(QuestionResolution::Dismissed { at }),
        Some(u) if u == U16String::from_str("cancelled").units() => Some(QuestionResolution::Cancelled { at }),
        _ => None,
    }
}

/// Decode a request — `pendingQuestions` validates with `is_question_request`
/// first; callers outside a checked `requests` array can use this directly and
/// get None on a malformed request.
pub fn decode_question_request(value: &Json) -> Option<QuestionRequest> {
    if !is_question_request(value) {
        return None;
    }
    Some(QuestionRequest {
        id: text(value.get("id")),
        questions: value
            .get("questions")
            .and_then(Json::as_array)
            .map(|list| list.iter().map(decode_question_item).collect())
            .unwrap_or_default(),
        asked_at: value.get("askedAt").and_then(Json::as_number).unwrap_or(f64::NAN),
        resolution: value.get("resolution").and_then(decode_resolution),
        raw: value.clone(),
    })
}

fn decode_question_item(value: &Json) -> QuestionItem {
    QuestionItem {
        question: text(value.get("question")),
        header: text(value.get("header")),
        options: value
            .get("options")
            .and_then(Json::as_array)
            .map(|list| {
                list.iter()
                    .map(|o| QuestionOption {
                        label: text(o.get("label")),
                        description: o.get("description").and_then(Json::as_str).map(|s| s.to_string_lossy()),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        multi_select: match value.get("multiSelect") { Some(Json::Bool(b)) => Some(*b), _ => None },
    }
}

fn decode_question(value: &Json) -> QuestionDoc {
    let requests = value
        .get("requests")
        .and_then(Json::as_array)
        .map(|list| list.iter().filter_map(decode_question_request).collect())
        .unwrap_or_default();
    QuestionDoc { requests, raw: value.clone() }
}

fn decode_diff(value: &Json) -> DiffDoc {
    DiffDoc { patch: text(value.get("patch")), raw: value.clone() }
}

fn decode_codemode_call(value: &Json) -> CodemodeCall {
    let status = match value.get("status").and_then(Json::as_str).map(|s| s.units()) {
        Some(u) if u == U16String::from_str("running").units() => CodemodeCallStatus::Running,
        Some(u) if u == U16String::from_str("error").units() => CodemodeCallStatus::Error,
        Some(u) if u == U16String::from_str("cancelled").units() => CodemodeCallStatus::Cancelled,
        _ => CodemodeCallStatus::Ok,
    };
    CodemodeCall {
        id: crate::json::num_key(value.get("id")),
        name: text(value.get("name")),
        args: text(value.get("args")),
        status,
        duration_ms: value.get("durationMs").and_then(Json::as_number),
        error: value.get("error").and_then(Json::as_str).map(|s| s.to_string_lossy()),
        raw: value.clone(),
    }
}

fn decode_codemode(value: &Json) -> CodemodeDoc {
    CodemodeDoc {
        code: value.get("code").and_then(Json::as_str).map(|s| s.to_string_lossy()),
        calls: value
            .get("calls")
            .and_then(Json::as_array)
            .map(|list| list.iter().map(decode_codemode_call).collect())
            .unwrap_or_default(),
        raw: value.clone(),
    }
}

/// `classify(presentation, value)`: `presentation` is the declared type as it
/// arrived (a `toolPresentations` entry or a doc's `presentation`), typically
/// a string or an absent field.
pub fn classify(presentation: Option<&Json>, value: &Json) -> ClassifiedDoc {
    let kind = presentation.and_then(Json::as_str);
    match kind {
        Some(s) if str_eq(s, "pinomad.todo") && is_todo(value) => ClassifiedDoc::Todo(decode_todo(value)),
        Some(s) if str_eq(s, "pinomad.question") && is_question(value) => {
            ClassifiedDoc::Question(decode_question(value))
        }
        Some(s) if str_eq(s, "pinomad.diff") && is_diff(value) => ClassifiedDoc::Diff(decode_diff(value)),
        Some(s) if str_eq(s, "pinomad.codemode") && is_codemode(value) => {
            ClassifiedDoc::Codemode(decode_codemode(value))
        }
        _ => ClassifiedDoc::Fallback(FallbackDoc { raw: value.clone() }),
    }
}

fn str_eq(value: &U16String, literal: &str) -> bool {
    value.units() == U16String::from_str(literal).units()
}

// ─── typebox primitives ─────────────────────────────────────────────────────

fn is_string(value: &Json) -> bool {
    value.as_str().is_some()
}

/// typebox `{minLength, maxLength}` counts code points: a surrogate pair is
/// one, a lone surrogate is one.
fn string_len(units: &[u16]) -> usize {
    let mut count = 0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += if (0xd800..=0xdbff).contains(&unit)
            && index + 1 < units.len()
            && (0xdc00..=0xdfff).contains(&units[index + 1])
        {
            2
        } else {
            1
        };
        count += 1;
    }
    count
}

fn string_of(value: Option<&Json>, min: usize, max: Option<usize>) -> bool {
    match value.and_then(Json::as_str) {
        Some(s) => {
            let len = string_len(s.units());
            len >= min && max.is_none_or(|m| len <= m)
        }
        None => false,
    }
}

/// typebox `Type.Number()` — `typeof number` minus NaN and Infinity.
fn is_number(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Number(v)) if v.is_finite())
}

fn is_boolean(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Bool(_)))
}

/// An optional field: absent passes, present must satisfy `check` — typebox
/// optional means `undefined`, and a JSON null does not count as absent.
fn opt(value: &Json, key: &str, check: impl Fn(Option<&Json>) -> bool) -> bool {
    match value.as_object().map(|o| o.get(&U16String::from_str(key).0)) {
        Some(None) | None => true,
        Some(Some(v)) => check(Some(v)),
    }
}

fn array_of(value: Option<&Json>, min: usize, max: Option<usize>, check: impl Fn(&Json) -> bool) -> bool {
    match value.and_then(Json::as_array) {
        Some(items) => items.len() >= min && max.is_none_or(|m| items.len() <= m) && items.iter().all(check),
        None => false,
    }
}

// ─── Schemas ────────────────────────────────────────────────────────────────

fn is_todo_item(value: &Json) -> bool {
    value.is_object()
        && string_of(value.get("text"), 1, None)
        && matches!(
            value.get("status").and_then(Json::as_str),
            Some(s) if str_eq(s, "pending") || str_eq(s, "in_progress") || str_eq(s, "completed")
        )
}

fn is_todo(value: &Json) -> bool {
    value.is_object() && array_of(value.get("items"), 0, None, is_todo_item)
}

fn is_question_option(value: &Json) -> bool {
    value.is_object()
        && string_of(value.get("label"), 1, None)
        && opt(value, "description", |v| v.is_some_and(is_string))
}

fn is_question_item(value: &Json) -> bool {
    value.is_object()
        && string_of(value.get("question"), 1, None)
        && string_of(value.get("header"), 1, Some(16))
        && array_of(value.get("options"), 2, Some(4), is_question_option)
        && opt(value, "multiSelect", is_boolean)
}

fn is_question_answer(value: &Json) -> bool {
    value.is_object()
        && array_of(value.get("selected"), 0, None, is_string)
        && opt(value, "other", |v| v.is_some_and(is_string))
}

fn is_question_resolution(value: Option<&Json>) -> bool {
    let Some(v) = value else { return false };
    if !v.is_object() || !is_number(v.get("at")) {
        return false;
    }
    match v.get("outcome").and_then(Json::as_str) {
        Some(s) if str_eq(s, "answered") => array_of(v.get("answers"), 0, None, is_question_answer),
        Some(s) => str_eq(s, "dismissed") || str_eq(s, "cancelled"),
        None => false,
    }
}

fn is_question_request(value: &Json) -> bool {
    value.is_object()
        && string_of(value.get("id"), 1, None)
        && array_of(value.get("questions"), 1, Some(4), is_question_item)
        && is_number(value.get("askedAt"))
        && opt(value, "resolution", is_question_resolution)
}

fn is_question(value: &Json) -> bool {
    value.is_object() && array_of(value.get("requests"), 0, None, is_question_request)
}

fn is_diff(value: &Json) -> bool {
    value.is_object() && value.get("patch").is_some_and(is_string)
}

fn is_codemode_call(value: &Json) -> bool {
    value.is_object()
        && opt(value, "id", is_number)
        && value.get("name").is_some_and(is_string)
        && value.get("args").is_some_and(is_string)
        && matches!(
            value.get("status").and_then(Json::as_str),
            Some(s) if str_eq(s, "running") || str_eq(s, "ok") || str_eq(s, "error") || str_eq(s, "cancelled")
        )
        && opt(value, "durationMs", is_number)
        && opt(value, "error", |v| v.is_some_and(is_string))
    // `details` is Type.Unknown — anything validates.
}

fn is_codemode(value: &Json) -> bool {
    value.is_object()
        && opt(value, "code", |v| v.is_some_and(is_string))
        && array_of(value.get("calls"), 0, None, is_codemode_call)
}
