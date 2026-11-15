//! Inbox mode (5.38, ADR-0051): the `inbox` host stream decoded, and the task
//! states the sidebar groups by (`packages/client/src/inbox.ts`). States are
//! derived from the task and its conversation's status, never stored.

use crate::json::Json;
use crate::questions::card::PendingQuestion;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct InboxEvent {
    pub id: String,
    /// `user`, `schedule`, `followUp`, `webhook`, or `plugin:<name>`.
    pub source: String,
    pub thread: Option<String>,
    /// A summary and pointers, never the full content (ADR-0051 §5).
    pub summary: String,
    /// Written by the user, not by an outside party.
    pub trusted: bool,
    /// Epoch milliseconds.
    pub received_at: f64,
    /// Sent to the task's conversation already.
    pub handled: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct InboxTask {
    pub id: String,
    pub title: String,
    pub created_at: f64,
    /// `None` until the worker first takes it.
    pub conversation_id: Option<u64>,
    pub events: Vec<InboxEvent>,
    /// The worker sent a batch of its events and that run has not settled.
    pub in_flight: bool,
    /// Done, skipped or failed; a later event reopens it.
    pub closed: bool,
    pub skipped: bool,
    /// Why the worker gave up on its last batch.
    pub failed: Option<String>,
    /// Its run stopped on a question to the user.
    pub waiting: bool,
    /// `tidy` for the Inbox's own memory tidy-up (ADR-0052 §3).
    pub kind: Option<String>,
    /// The questions its conversation waits on (5.41), answered with
    /// `answer` on `conversation_id` and the `kind` given here; empty when none.
    #[cfg_attr(feature = "ffi", uniffi(default = []))]
    pub questions: Vec<PendingQuestion>,
}

/// A timer not yet fired: a follow-up (`task`) or a schedule (`every`).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct InboxFollowUp {
    pub id: String,
    /// Epoch milliseconds of the next fire.
    pub due: f64,
    pub note: String,
    pub task: Option<String>,
    /// A schedule's period in milliseconds.
    pub every: Option<f64>,
    /// `tidy` for the daily tidy-up, which `CancelFollowUp` refuses.
    pub kind: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ProjectInbox {
    /// The project's path, as in the index.
    pub project: String,
    /// The intake conversation (ADR-0051 §6), once the user wrote to it.
    pub intake: Option<u64>,
    pub tasks: Vec<InboxTask>,
    /// thread → task id.
    pub threads: HashMap<String, String>,
    /// The user's rules (`instructions.md`); empty when unset.
    pub rules: String,
    /// Soonest first. A schedule source's timer is not one: it is the source's `next`.
    pub follow_ups: Vec<InboxFollowUp>,
    /// Its event sources (5.39, ADR-0051 §10), oldest first; empty before 5.39.
    #[cfg_attr(feature = "ffi", uniffi(default = []))]
    pub sources: Vec<InboxSource>,
    /// The local branch the intake reads and tasks start from (5.41): the
    /// user's choice or the repository's default. `None` for a project that
    /// is not a Git repository, and before 5.41.
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub base_branch: Option<String>,
}

/// When a schedule source fires (5.39), as wall time in `time_zone` (IANA).
/// `time` is `HH:MM`; `day` is 0 (Sunday) to 6; `expression` is five cron fields.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum InboxSchedule {
    Daily { time: String, time_zone: String },
    Weekdays { time: String, time_zone: String },
    Weekly { day: u8, time: String, time_zone: String },
    Cron { expression: String, time_zone: String },
}

/// What a source is (5.39): a schedule writing `note`, one of a plugin's
/// declared sources with the user's `filter`, or a LAN webhook.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum InboxSourceSpec {
    Schedule { schedule: InboxSchedule, note: String },
    Plugin { plugin: String, source: String, filter: String },
    Webhook,
}

/// One event source of an Inbox (5.39, ADR-0051 §10).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct InboxSource {
    pub id: String,
    pub name: String,
    pub spec: InboxSourceSpec,
    pub enabled: bool,
    /// Its events count as the user's own ("all tools") rather than outside content.
    pub trusted: bool,
    pub created_at: f64,
    /// A schedule's next fire, epoch milliseconds; `None` while disabled.
    pub next: Option<f64>,
    /// Why it could not deliver lately.
    pub problem: Option<String>,
}

/// A webhook source's address and signing secret, from `addInboxSource` or
/// `resetInboxWebhookSecret` only (5.39).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct InboxWebhookAccess {
    pub url: String,
    /// Sent as the `X-Pinomad-Source` header.
    pub source: String,
    pub secret: String,
}

impl InboxSchedule {
    fn of(value: &Json) -> Option<Self> {
        let time_zone = text(value.get("timeZone"))?;
        let time = || text(value.get("time"));
        Some(match text(value.get("kind"))?.as_str() {
            "daily" => Self::Daily { time: time()?, time_zone },
            "weekdays" => Self::Weekdays { time: time()?, time_zone },
            "weekly" => Self::Weekly {
                day: value.get("day").and_then(Json::as_number).filter(|d| d.fract() == 0.0 && (0.0..=6.0).contains(d))? as u8,
                time: time()?,
                time_zone,
            },
            "cron" => Self::Cron { expression: text(value.get("expression"))?, time_zone },
            _ => return None,
        })
    }

    pub fn to_json(&self) -> Json {
        match self {
            Self::Daily { time, time_zone } => object(&[("kind", "daily".into()), ("time", time.as_str().into()), ("timeZone", time_zone.as_str().into())]),
            Self::Weekdays { time, time_zone } => object(&[("kind", "weekdays".into()), ("time", time.as_str().into()), ("timeZone", time_zone.as_str().into())]),
            Self::Weekly { day, time, time_zone } => object(&[
                ("kind", "weekly".into()),
                ("day", Json::Number(f64::from(*day))),
                ("time", time.as_str().into()),
                ("timeZone", time_zone.as_str().into()),
            ]),
            Self::Cron { expression, time_zone } => object(&[("kind", "cron".into()), ("expression", expression.as_str().into()), ("timeZone", time_zone.as_str().into())]),
        }
    }
}

impl InboxSourceSpec {
    fn of(value: &Json) -> Option<Self> {
        Some(match text(value.get("kind"))?.as_str() {
            "schedule" => Self::Schedule { schedule: InboxSchedule::of(value.get("schedule")?)?, note: text(value.get("note")).unwrap_or_default() },
            "plugin" => Self::Plugin {
                plugin: text(value.get("plugin"))?,
                source: text(value.get("source"))?,
                filter: text(value.get("filter")).unwrap_or_default(),
            },
            "webhook" => Self::Webhook,
            _ => return None,
        })
    }

    /// The wire's `InboxSourceSpec`, as `addInboxSource` takes it.
    pub fn to_json(&self) -> Json {
        match self {
            Self::Schedule { schedule, note } => object(&[("kind", "schedule".into()), ("schedule", schedule.to_json()), ("note", note.as_str().into())]),
            Self::Plugin { plugin, source, filter } => object(&[
                ("kind", "plugin".into()),
                ("plugin", plugin.as_str().into()),
                ("source", source.as_str().into()),
                ("filter", filter.as_str().into()),
            ]),
            Self::Webhook => object(&[("kind", "webhook".into())]),
        }
    }
}

impl InboxWebhookAccess {
    /// `addInboxSource`'s `webhook` or `resetInboxWebhookSecret`'s result; `None` when malformed.
    pub fn of(value: &Json) -> Option<Self> {
        Some(Self { url: text(value.get("url"))?, source: text(value.get("source"))?, secret: text(value.get("secret"))? })
    }
}

fn object(fields: &[(&str, Json)]) -> Json {
    let mut out = crate::json::JsonObject::new();
    for (key, value) in fields {
        out.set(crate::u16str::U16String::from_str(key), value.clone());
    }
    Json::Object(std::sync::Arc::new(out))
}

fn source_of(value: &Json) -> Option<InboxSource> {
    Some(InboxSource {
        id: text(value.get("id"))?,
        name: text(value.get("name")).unwrap_or_default(),
        spec: InboxSourceSpec::of(value.get("spec")?)?,
        enabled: flag(value.get("enabled")),
        trusted: flag(value.get("trusted")),
        created_at: number(value.get("createdAt")),
        next: value.get("next").and_then(Json::as_number),
        problem: text(value.get("problem")),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum InboxTaskState {
    Pending,
    Running,
    Waiting,
    Done,
    Skipped,
    Failed,
}

impl InboxTaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    pub fn group(self) -> InboxGroupName {
        match self {
            Self::Waiting => InboxGroupName::Waiting,
            Self::Running => InboxGroupName::Running,
            Self::Pending => InboxGroupName::Pending,
            Self::Done | Self::Skipped | Self::Failed => InboxGroupName::Done,
        }
    }
}

/// The sidebar's groups, in its order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum InboxGroupName {
    Waiting,
    Running,
    Pending,
    Done,
}

impl InboxGroupName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Running => "running",
            Self::Pending => "pending",
            Self::Done => "done",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct InboxGroup {
    pub group: InboxGroupName,
    pub tasks: Vec<InboxTask>,
}

/// What a task reads as; `status` is its conversation summary's `status`
/// (`running`, `needs-answer`, `failed`), when it has one (`inboxTaskState`).
pub fn inbox_task_state(task: &InboxTask, status: Option<&str>) -> InboxTaskState {
    if task.failed.is_some() {
        return InboxTaskState::Failed;
    }
    if task.skipped {
        return InboxTaskState::Skipped;
    }
    if task.closed {
        return InboxTaskState::Done;
    }
    // The conversation's live status first: `waiting` stays set until the
    // answered run settles, while the run is already going again.
    match status {
        Some("needs-answer") => return InboxTaskState::Waiting,
        Some("running") => return InboxTaskState::Running,
        _ => {}
    }
    if task.waiting {
        return InboxTaskState::Waiting;
    }
    if task.in_flight {
        return InboxTaskState::Running;
    }
    if task.events.iter().any(|event| !event.handled) {
        return InboxTaskState::Pending;
    }
    InboxTaskState::Done
}

fn last_event_at(task: &InboxTask) -> f64 {
    task.events.iter().fold(task.created_at, |at, event| at.max(event.received_at))
}

fn first_pending_at(task: &InboxTask) -> f64 {
    task.events
        .iter()
        .filter(|event| !event.handled)
        .fold(f64::INFINITY, |at, event| at.min(event.received_at))
}

/// The four groups in sidebar order (`groupInboxTasks`): pending in the
/// worker's order (longest-waiting event first), the rest newest activity
/// first; ties keep the tasks' order. `status_of` gives a conversation's
/// summary status.
pub fn group_inbox_tasks(tasks: &[InboxTask], status_of: &dyn Fn(u64) -> Option<String>) -> Vec<InboxGroup> {
    let mut groups: [Vec<InboxTask>; 4] = Default::default();
    for task in tasks {
        let status = task.conversation_id.and_then(status_of);
        let index = match inbox_task_state(task, status.as_deref()).group() {
            InboxGroupName::Waiting => 0,
            InboxGroupName::Running => 1,
            InboxGroupName::Pending => 2,
            InboxGroupName::Done => 3,
        };
        groups[index].push(task.clone());
    }
    let newest_first = |list: &mut Vec<InboxTask>| {
        list.sort_by(|a, b| last_event_at(b).partial_cmp(&last_event_at(a)).unwrap_or(std::cmp::Ordering::Equal));
    };
    let [mut waiting, mut running, mut pending, mut done] = groups;
    newest_first(&mut waiting);
    newest_first(&mut running);
    pending.sort_by(|a, b| first_pending_at(a).partial_cmp(&first_pending_at(b)).unwrap_or(std::cmp::Ordering::Equal));
    newest_first(&mut done);
    vec![
        InboxGroup { group: InboxGroupName::Waiting, tasks: waiting },
        InboxGroup { group: InboxGroupName::Running, tasks: running },
        InboxGroup { group: InboxGroupName::Pending, tasks: pending },
        InboxGroup { group: InboxGroupName::Done, tasks: done },
    ]
}

fn text(value: Option<&Json>) -> Option<String> {
    value.and_then(Json::as_str).map(|s| s.to_string_lossy())
}

fn number(value: Option<&Json>) -> f64 {
    value.and_then(Json::as_number).unwrap_or(0.0)
}

fn flag(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Bool(true)))
}

fn list<T>(value: Option<&Json>, decode: impl Fn(&Json) -> Option<T>) -> Vec<T> {
    value.and_then(Json::as_array).map(|items| items.iter().filter_map(decode).collect()).unwrap_or_default()
}

fn event_of(value: &Json) -> Option<InboxEvent> {
    Some(InboxEvent {
        id: text(value.get("id"))?,
        source: text(value.get("source")).unwrap_or_default(),
        thread: text(value.get("thread")),
        summary: text(value.get("summary")).unwrap_or_default(),
        trusted: flag(value.get("trusted")),
        received_at: number(value.get("receivedAt")),
        handled: flag(value.get("handled")),
    })
}

/// One task off the wire; an entry without an id is dropped.
pub fn task_of(value: &Json) -> Option<InboxTask> {
    Some(InboxTask {
        id: text(value.get("id"))?,
        title: text(value.get("title")).unwrap_or_default(),
        created_at: number(value.get("createdAt")),
        conversation_id: crate::json::num_key(value.get("conversationId")),
        events: list(value.get("events"), event_of),
        in_flight: flag(value.get("inFlight")),
        closed: flag(value.get("closed")),
        skipped: flag(value.get("skipped")),
        failed: text(value.get("failed")),
        waiting: flag(value.get("waiting")),
        kind: text(value.get("kind")),
        questions: list(value.get("questions"), question_of),
    })
}

/// One `InboxQuestion`; a malformed request is dropped.
fn question_of(value: &Json) -> Option<PendingQuestion> {
    let request = crate::presentation::decode_question_request(value.get("request")?)?;
    Some(PendingQuestion { kind: text(value.get("kind"))?, request: request.into() })
}

fn follow_up_of(value: &Json) -> Option<InboxFollowUp> {
    Some(InboxFollowUp {
        id: text(value.get("id"))?,
        due: number(value.get("due")),
        note: text(value.get("note")).unwrap_or_default(),
        task: text(value.get("task")),
        every: value.get("every").and_then(Json::as_number),
        kind: text(value.get("kind")),
    })
}

fn project_inbox_of(value: &Json) -> Option<ProjectInbox> {
    let threads = value
        .get("threads")
        .and_then(Json::as_object)
        .map(|object| {
            object
                .iter_insertion()
                .filter_map(|(thread, task)| Some((thread.to_string_lossy(), task.as_str()?.to_string_lossy())))
                .collect()
        })
        .unwrap_or_default();
    Some(ProjectInbox {
        project: text(value.get("project"))?,
        intake: crate::json::num_key(value.get("intake")),
        tasks: list(value.get("tasks"), task_of),
        threads,
        rules: text(value.get("rules")).unwrap_or_default(),
        follow_ups: list(value.get("followUps"), follow_up_of),
        sources: list(value.get("sources"), source_of),
        base_branch: text(value.get("baseBranch")),
    })
}

/// The `inboxQuietHours` host setting (5.38, ADR-0052 §4): local minutes after
/// midnight, `start` inclusive, wrapping past midnight; equal ends mean none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct QuietHours {
    pub start: u32,
    pub end: u32,
}

impl QuietHours {
    /// The settings value; `None` when unset, absent or malformed.
    pub fn of(value: Option<&Json>) -> Option<Self> {
        let value = value?;
        let minute = |key: &str| {
            value
                .get(key)
                .and_then(Json::as_number)
                .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < 1440.0)
                .map(|n| n as u32)
        };
        Some(Self { start: minute("start")?, end: minute("end")? })
    }

    pub fn to_json(self) -> Json {
        let mut object = crate::json::JsonObject::new();
        object.set(crate::u16str::U16String::from_str("start"), Json::Number(self.start as f64));
        object.set(crate::u16str::U16String::from_str("end"), Json::Number(self.end as f64));
        Json::Object(std::sync::Arc::new(object))
    }
}

/// Whether the host takes plugin and webhook sources (`inbox.externalSources`,
/// 5.39): only with a sandbox for Inbox runs. `None` before the snapshot or on
/// an older host.
pub fn external_sources_of(value: &Json) -> Option<bool> {
    match value.get("externalSources") {
        Some(Json::Bool(available)) => Some(*available),
        _ => None,
    }
}

/// The `inbox` stream's value; `None` before its snapshot or on a host older
/// than 5.38. Malformed entries are dropped, not fatal.
pub fn inboxes_of(value: &Json) -> Option<Vec<ProjectInbox>> {
    if !value.is_object() {
        return None;
    }
    Some(list(value.get("inboxes"), project_inbox_of))
}

/// One `hello.plugins` entry as the add-source form reads it (`PluginInfo`):
/// its name and the Inbox event sources it declares (5.39, ADR-0051 §10).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PluginInfo {
    pub name: String,
    /// The plugin API version it is written against.
    pub api: f64,
    /// Empty when it declares none.
    pub sources: Vec<PluginSourceInfo>,
}

/// `PluginSourceInfo`: one event source a plugin declares.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PluginSourceInfo {
    /// What `addInboxSource`'s plugin spec names as `source`.
    pub name: String,
    /// The kind of event, in the plugin's words: "New issues".
    pub description: String,
    /// What the user's filter means; `None` when the source takes no filter.
    pub filter: Option<String>,
    /// Its events only reach a task that already follows their thread.
    pub followed_only: bool,
}

fn plugin_source_of(value: &Json) -> Option<PluginSourceInfo> {
    Some(PluginSourceInfo {
        name: text(value.get("name")).filter(|name| !name.is_empty())?,
        description: text(value.get("description")).unwrap_or_default(),
        filter: text(value.get("filter")),
        followed_only: flag(value.get("followedOnly")),
    })
}

/// `view.host.plugins`, typed: the entries `plugin_infos` kept, each with
/// its sources; a source without a name is dropped.
pub fn plugins_of(host: Option<&Json>) -> Vec<PluginInfo> {
    list(host.and_then(|host| host.get("plugins")), |entry| {
        Some(PluginInfo {
            name: text(entry.get("name"))?,
            api: number(entry.get("api")),
            sources: list(entry.get("sources"), plugin_source_of),
        })
    })
}
