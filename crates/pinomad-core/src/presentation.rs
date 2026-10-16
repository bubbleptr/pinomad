// The `classify` boundary from packages/protocol/src/presentation.ts: the
// declared presentation type plus a value that conforms to its schema gets
// the typed view; anything else — including a presentation a newer host
// invented — falls back. The schema checks below mirror typebox's
// Value.Check exactly: objects reject arrays and null, `minLength` counts
// code points (not UTF-16 units), and Type.Number rejects NaN and Infinity.

use crate::json::Json;
use crate::u16str::U16String;

/// A tool-result `details` or extension document after `classify`. Each
/// variant keeps the raw value: the reference hands it through verbatim.
#[derive(Clone, Debug)]
pub enum ClassifiedDoc {
    Todo(Json),
    Question(Json),
    Diff(Json),
    Codemode(Json),
    Fallback(Json),
}

impl ClassifiedDoc {
    /// `classified.value` — the document the variant carries.
    pub fn value(&self) -> &Json {
        match self {
            ClassifiedDoc::Todo(v)
            | ClassifiedDoc::Question(v)
            | ClassifiedDoc::Diff(v)
            | ClassifiedDoc::Codemode(v)
            | ClassifiedDoc::Fallback(v) => v,
        }
    }

    /// The wire tag the reference emits for this variant.
    pub fn doc_type(&self) -> &'static str {
        match self {
            ClassifiedDoc::Todo(_) => "pinomad.todo",
            ClassifiedDoc::Question(_) => "pinomad.question",
            ClassifiedDoc::Diff(_) => "pinomad.diff",
            ClassifiedDoc::Codemode(_) => "pinomad.codemode",
            ClassifiedDoc::Fallback(_) => "fallback",
        }
    }
}

/// `classify(presentation, value)`: `presentation` is the declared type as it
/// arrived (a `toolPresentations` entry or a doc's `presentation`), typically
/// a string or an absent field.
pub fn classify(presentation: Option<&Json>, value: &Json) -> ClassifiedDoc {
    let kind = presentation.and_then(Json::as_str);
    match kind {
        Some(s) if str_eq(s, "pinomad.todo") && is_todo(value) => ClassifiedDoc::Todo(value.clone()),
        Some(s) if str_eq(s, "pinomad.question") && is_question(value) => ClassifiedDoc::Question(value.clone()),
        Some(s) if str_eq(s, "pinomad.diff") && is_diff(value) => ClassifiedDoc::Diff(value.clone()),
        Some(s) if str_eq(s, "pinomad.codemode") && is_codemode(value) => {
            ClassifiedDoc::Codemode(value.clone())
        }
        _ => ClassifiedDoc::Fallback(value.clone()),
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
