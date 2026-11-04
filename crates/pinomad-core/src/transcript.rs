// The pieces of packages/protocol/src/transcript.ts the apps need: whether
// the conversation has a run in flight, and transcript paging (5.28).

use std::sync::Arc;

use crate::json::{num_key, Json, JsonObject};
use crate::u16str::U16String;

/// `isBusy(view)` — `pi.live.run` is present exactly while a run is in flight.
/// An absent `pi.live` doc — or one that is not an object — reads as idle.
pub fn is_busy(view: &Json) -> bool {
    view.get("docs")
        .and_then(|docs| docs.get("pi.live"))
        .and_then(|live| live.get("run"))
        .is_some()
}

/// How many entries a client asks for per window or page (`TRANSCRIPT_PAGE`).
pub const TRANSCRIPT_PAGE: u32 = 50;

/// A conversation subscribe's window (5.28): what the first snapshot holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TranscriptWindow {
    /// The newest entries the first snapshot holds, extended back to the
    /// turn the oldest falls in.
    pub limit: u32,
    /// Start the first snapshot at this entry instead, inclusive: a
    /// resubscribe keeping everything the client had loaded.
    pub from: Option<u64>,
}

impl TranscriptWindow {
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        object.set(U16String::from_str("limit"), Json::Number(self.limit as f64));
        if let Some(from) = self.from {
            object.set(U16String::from_str("from"), Json::Number(from as f64));
        }
        Json::Object(Arc::new(object))
    }
}

/// Entries oldest first; `before` is the entry just ahead of them, absent at
/// the transcript's start. Entry objects pass through untouched.
#[derive(Clone, Debug)]
pub struct TranscriptPage {
    pub entries: Vec<Json>,
    pub before: Option<u64>,
}

impl TranscriptPage {
    /// An `earlierEntries` result. `entries` must be an array and `before`,
    /// when present, an entry id.
    pub fn from_json(value: &Json) -> Result<Self, String> {
        let entries = value
            .get("entries")
            .and_then(Json::as_array)
            .ok_or_else(|| "earlierEntries result has no entries array".to_string())?;
        let before = match value.get("before") {
            None => None,
            Some(before) => {
                Some(num_key(Some(before)).ok_or_else(|| "earlierEntries result has a malformed before".to_string())?)
            }
        };
        Ok(TranscriptPage { entries: entries.as_ref().clone(), before })
    }

    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        object.set(U16String::from_str("entries"), Json::array(self.entries.clone()));
        if let Some(before) = self.before {
            object.set(U16String::from_str("before"), Json::Number(before as f64));
        }
        Json::Object(Arc::new(object))
    }
}

/// `withEarlier` — the view a client shows: the pages it loaded with
/// `earlierEntries` ahead of the stream's window. The result keeps the
/// view's key order with `before` moved last, or dropped when the pages
/// reach the transcript's start.
pub fn with_earlier(view: &Json, earlier: Option<&TranscriptPage>) -> Json {
    let (Some(earlier), Some(object)) = (earlier, view.as_object()) else {
        return view.clone();
    };
    let mut shown = object.as_ref().clone();
    shown.remove(&U16String::from_str("before").0);
    let mut entries = earlier.entries.clone();
    if let Some(window) = view.get("entries").and_then(Json::as_array) {
        entries.extend(window.iter().cloned());
    }
    shown.set(U16String::from_str("entries"), Json::array(entries));
    if let Some(before) = earlier.before {
        shown.set(U16String::from_str("before"), Json::Number(before as f64));
    }
    Json::Object(Arc::new(shown))
}

/// `addEarlier` — `earlier` with `page` ahead of it. A page asked for a
/// `before` the shown view no longer has (a resubscribe replaced the window
/// meanwhile) would leave a gap or an overlap, so it is dropped.
pub fn add_earlier(
    shown: &Json,
    earlier: Option<&TranscriptPage>,
    requested: u64,
    page: &TranscriptPage,
) -> Option<TranscriptPage> {
    if num_key(shown.get("before")) != Some(requested) {
        return earlier.cloned();
    }
    let mut entries = page.entries.clone();
    if let Some(earlier) = earlier {
        entries.extend(earlier.entries.iter().cloned());
    }
    Some(TranscriptPage { entries, before: page.before })
}
