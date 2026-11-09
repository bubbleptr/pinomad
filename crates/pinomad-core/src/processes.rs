//! Background-process derivations (ADR-0045): the family root's
//! `pinomad.processes` document, ordered for the Tasks/Overview list, with
//! the same status and short-result wording as the Web client. The host keeps
//! the list; this module only reads and formats it.

use crate::frames::{HostFeature, host_supports_feature};
use crate::json::Json;
use crate::presentation::{ClassifiedDoc, classify};

/// One process state from the document. `lost` means the previous host never
/// finished with it: it may still run, but this host no longer tracks it.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ProcessState {
    Starting,
    Running,
    /// `exited` is the code, and `null` (or no code) means it died by signal.
    Exited {
        exited: Option<i64>,
        signal: Option<String>,
    },
    Stopped {
        stopped: String,
    },
    Failed {
        failed: String,
    },
    Lost,
}

impl ProcessState {
    /// Whether the entry still counts against the family limit and can be
    /// stopped (protocol's `isProcessActive`).
    pub fn is_active(&self) -> bool {
        matches!(self, ProcessState::Starting | ProcessState::Running)
    }
}

/// One process as the list renders it. `status` is the long state line and
/// `result` the short right-hand text; both are derived here so iOS and the
/// Web client say the same thing.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct BackgroundProcess {
    pub id: String,
    pub owner: u64,
    pub name: String,
    pub command: String,
    pub pid: Option<u64>,
    pub started_at: f64,
    pub ended_at: Option<f64>,
    pub state: ProcessState,
    pub active: bool,
    pub status: String,
    pub result: String,
}

/// The watched family root's process list. `stop_available` is the host
/// minor plus `hello.processes` gate; `unavailable` says why Stop is gone.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ProcessesView {
    pub root: u64,
    pub processes: Vec<BackgroundProcess>,
    pub stop_available: bool,
    pub unavailable: Option<String>,
}

/// The readiness line and Stop gate for a host that may have no pty module.
pub fn unavailable_reason(host_minor: u32, host_processes: bool) -> Option<String> {
    if !host_supports_feature(host_minor, HostFeature::Processes) {
        return Some(
            "The host is too old for background processes (needs protocol 5.32); run `pinomad upgrade` on the host"
                .to_string(),
        );
    }
    if !host_processes {
        return Some(
            "The host couldn't load its process module; its log says which package is missing"
                .to_string(),
        );
    }
    None
}

/// The root document's entries in the document's host order.
pub fn processes_of(value: &Json) -> Vec<BackgroundProcess> {
    let presentation = Json::from("pinomad.processes");
    let ClassifiedDoc::Processes(doc) = classify(Some(&presentation), value) else {
        return Vec::new();
    };
    let value = doc.to_json();
    value
        .get("processes")
        .and_then(Json::as_array)
        .map(|entries| entries.iter().map(decode_process).collect())
        .unwrap_or_default()
}

fn decode_process(value: &Json) -> BackgroundProcess {
    let state = state_of(value.get("state").unwrap_or(&Json::Null));
    let pid = crate::json::num_key(value.get("pid"));
    let active = state.is_active();
    BackgroundProcess {
        id: text(value.get("id")),
        owner: crate::json::num_key(value.get("owner")).unwrap_or(0),
        name: text(value.get("name")),
        command: text(value.get("command")),
        pid,
        started_at: number(value.get("startedAt")),
        ended_at: value.get("endedAt").and_then(Json::as_number),
        status: status_text(&state, pid),
        result: result_text(&state),
        state,
        active,
    }
}

/// Decode one `ProcessState` wire value. `processes_of` has already checked
/// the schema; callers outside it get a renderable state rather than a panic.
pub fn state_of(value: &Json) -> ProcessState {
    if let Some(text) = value.as_str() {
        let units = text.units();
        if units == crate::u16str::U16String::from_str("starting").units() {
            return ProcessState::Starting;
        }
        if units == crate::u16str::U16String::from_str("running").units() {
            return ProcessState::Running;
        }
        if units == crate::u16str::U16String::from_str("lost").units() {
            return ProcessState::Lost;
        }
    }
    if let Some(exited) = value.get("exited") {
        let exited = match exited {
            Json::Null => None,
            Json::Number(code) => Some(*code as i64),
            _ => None,
        };
        return ProcessState::Exited {
            exited,
            signal: value
                .get("signal")
                .and_then(Json::as_str)
                .map(|s| s.to_string_lossy()),
        };
    }
    if let Some(stopped) = value.get("stopped").and_then(Json::as_str) {
        return ProcessState::Stopped {
            stopped: stopped.to_string_lossy(),
        };
    }
    if let Some(failed) = value.get("failed").and_then(Json::as_str) {
        return ProcessState::Failed {
            failed: failed.to_string_lossy(),
        };
    }
    // The schema check rejects this; a caller outside `processes_of` still
    // gets a state it can render rather than a panic.
    ProcessState::Lost
}

fn text(value: Option<&Json>) -> String {
    value
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .unwrap_or_default()
}

fn number(value: Option<&Json>) -> f64 {
    value.and_then(Json::as_number).unwrap_or(f64::NAN)
}

/// The Tasks/Overview order: live processes first in host order, then ended
/// ones newest first by `endedAt`, falling back to `startedAt`.
pub fn ordered_processes(mut processes: Vec<BackgroundProcess>) -> Vec<BackgroundProcess> {
    processes.sort_by(|a, b| {
        if a.active != b.active {
            return if a.active {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        if a.active {
            return std::cmp::Ordering::Equal;
        }
        let a_ended = a.ended_at.unwrap_or(a.started_at);
        let b_ended = b.ended_at.unwrap_or(b.started_at);
        b_ended
            .partial_cmp(&a_ended)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    processes
}

/// The long state line (`processStatusText`) plus the pid for `lost`, which
/// must not claim the process stopped.
pub fn status_text(state: &ProcessState, pid: Option<u64>) -> String {
    match state {
        ProcessState::Starting => "Starting".to_string(),
        ProcessState::Running => "Running".to_string(),
        ProcessState::Lost => {
            let line = "Lost track after a host restart; it may still be running";
            match pid {
                Some(pid) => format!("{line} (pid {pid})"),
                None => line.to_string(),
            }
        }
        ProcessState::Stopped { stopped } => match stopped.as_str() {
            "agent" => "Stopped by the agent".to_string(),
            "user" => "Stopped by the user".to_string(),
            "archive" => "Stopped when the conversation was archived".to_string(),
            "shutdown" => "Stopped when the host shut down".to_string(),
            _ => "Stopped".to_string(),
        },
        ProcessState::Failed { failed } => format!("Failed to start: {failed}"),
        ProcessState::Exited { exited, signal } => {
            if let Some(signal) = signal {
                return format!("Exited after signal {signal}");
            }
            match exited {
                Some(code) => format!("Exited with code {code}"),
                None => "Exited".to_string(),
            }
        }
    }
}

/// The short right-hand result: `exit 1`, `Stopped`, `Lost`, `Failed`.
pub fn result_text(state: &ProcessState) -> String {
    match state {
        ProcessState::Starting | ProcessState::Running => String::new(),
        ProcessState::Lost => "Lost".to_string(),
        ProcessState::Stopped { .. } => "Stopped".to_string(),
        ProcessState::Failed { .. } => "Failed".to_string(),
        ProcessState::Exited { exited, signal } => match (signal, exited) {
            (Some(signal), _) => signal.clone(),
            (None, Some(code)) => format!("exit {code}"),
            (None, None) => "exit ?".to_string(),
        },
    }
}

/// A watched root's view; `value` is `None` until the doc's first snapshot.
pub fn view(
    root: u64,
    value: Option<&Json>,
    host_minor: u32,
    host_processes: bool,
) -> ProcessesView {
    let unavailable = unavailable_reason(host_minor, host_processes);
    let processes = value.map(processes_of).unwrap_or_default();
    ProcessesView {
        root,
        processes: ordered_processes(processes),
        stop_available: unavailable.is_none(),
        unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(id: &str, started_at: f64, ended_at: Option<f64>, state: &str) -> Json {
        let mut fields = vec![
            ("id".to_string(), Json::from(id)),
            ("owner".to_string(), Json::from(3.0)),
            ("name".to_string(), Json::from(id)),
            ("command".to_string(), Json::from(format!("run {id}"))),
            ("startedAt".to_string(), Json::from(started_at)),
            ("state".to_string(), Json::parse(state).expect("state json")),
        ];
        if let Some(ended_at) = ended_at {
            fields.push(("endedAt".to_string(), Json::from(ended_at)));
        }
        let mut object = crate::json::JsonObject::new();
        for (name, value) in fields {
            object.set(crate::u16str::U16String::from_str(&name), value);
        }
        Json::Object(std::sync::Arc::new(object))
    }

    fn document(entries: Vec<Json>) -> Json {
        let mut object = crate::json::JsonObject::new();
        object.set(
            crate::u16str::U16String::from_str("processes"),
            Json::array(entries),
        );
        Json::Object(std::sync::Arc::new(object))
    }

    /// Ended entries sort newest first; live ones keep the host's start order
    /// ahead of them, so a restart's leftover lost entry does not jump the run
    /// that is still going.
    #[test]
    fn live_processes_come_first_then_ended_newest_first() {
        let value = document(vec![
            process("old", 10.0, Some(20.0), r#"{"exited":0}"#),
            process("run", 30.0, None, r#""running""#),
            process("lost", 5.0, Some(40.0), r#""lost""#),
            process("start", 50.0, None, r#""starting""#),
            process("new", 60.0, Some(70.0), r#"{"stopped":"user"}"#),
        ]);
        let ordered = ordered_processes(processes_of(&value));
        assert_eq!(
            ordered.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["run", "start", "new", "lost", "old"]
        );
    }

    /// The long `lost` line names the restart and the old pid, and never says
    /// the process stopped; the row's short result stays `Lost`.
    #[test]
    fn lost_says_the_host_lost_track_and_keeps_the_pid() {
        let state = ProcessState::Lost;
        assert_eq!(
            status_text(&state, Some(777)),
            "Lost track after a host restart; it may still be running (pid 777)"
        );
        assert_eq!(
            status_text(&state, None),
            "Lost track after a host restart; it may still be running"
        );
        assert_eq!(result_text(&state), "Lost");
        assert!(!state.is_active());
    }

    /// The list must not stop offering Stop just because the pty module did
    /// not load; only the stop/output capability is missing then.
    #[test]
    fn stop_needs_both_the_protocol_minor_and_hello_capability() {
        assert!(unavailable_reason(32, true).is_none());
        assert!(unavailable_reason(31, true).is_some());
        assert!(unavailable_reason(32, false).is_some());
    }

    /// A malformed document is not a list: the client falls back to empty
    /// rather than rendering half-valid entries.
    #[test]
    fn a_malformed_document_is_empty() {
        let value = Json::parse(r#"{"processes":[{"id":"p1","owner":3}]}"#).unwrap();
        assert!(processes_of(&value).is_empty());
    }
}
