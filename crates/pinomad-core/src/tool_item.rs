// `tool-item.ts`: the DOM-free shape of one tool call in a transcript, plus
// the display helpers every client renders with — display names, targets,
// durations, and the kind icon class.

use crate::json::Json;
use crate::tool_target::tool_target;

/// Lifecycle of a tool invocation as rendered in the trace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolPartState {
    InputStreaming,
    InputAvailable,
    OutputAvailable,
    OutputError,
}

impl ToolPartState {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolPartState::InputStreaming => "input-streaming",
            ToolPartState::InputAvailable => "input-available",
            ToolPartState::OutputAvailable => "output-available",
            ToolPartState::OutputError => "output-error",
        }
    }
}

/// Per-edit line counts; rendered as additions/deletions stats.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiffStat {
    pub additions: f64,
    pub deletions: f64,
}

/// An image block carried on a tool result or a user message.
#[derive(Clone, Debug, PartialEq)]
pub struct MessageImage {
    pub data: String,
    pub mime_type: String,
}

/// Tool rendering the item shape cannot express as data (ADR-0005).
#[derive(Clone, Debug, PartialEq)]
pub enum PinomadToolDetail {
    Diff { patch: String },
    Subagent {
        conversation_id: f64,
        output: Option<String>,
        /// "provider/modelId" the child ran, recorded by the host.
        model: Option<String>,
        /// Epoch ms the child was created, recorded by the host.
        started_at: Option<f64>,
        /// The tool result's timestamp — the run's end for elapsed time.
        ended_at: Option<f64>,
    },
}

/// One tool call in a transcript, as data. Optional fields mirror the
/// reference's "absent means omit" convention.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolItem {
    pub state: ToolPartState,
    pub args_text: Option<String>,
    /// Nested calls this call started, in start order.
    pub children: Vec<ToolItem>,
    pub diff_stat: Option<DiffStat>,
    pub duration_ms: Option<f64>,
    /// Image blocks of the tool result, rendered after the output pane.
    pub images: Vec<MessageImage>,
    pub output: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub pinomad: Option<PinomadToolDetail>,
}

/// `pinomadOf` — the `pinomad` payload a tool item may carry.
pub fn pinomad_of(tool: &ToolItem) -> Option<&PinomadToolDetail> {
    tool.pinomad.as_ref()
}

/// `toolDisplayName`: `mcp__<server>__<tool>` reads as `<server>/<tool>`,
/// matching how Pi's TUI titles MCP calls. Anything else is unchanged.
pub fn tool_display_name(name: Option<&str>) -> Option<String> {
    let name = name?;
    let Some(rest) = name.strip_prefix("mcp__") else {
        return Some(name.to_string());
    };
    Some(match rest.find("__") {
        Some(at) => format!("{}/{}", &rest[..at], &rest[at + 2..]),
        None => rest.to_string(),
    })
}

/// `toolTargetFromArgs` — parse the args text and pull the target key.
pub fn tool_target_from_args(args_text: Option<&str>) -> Option<String> {
    let args = Json::parse(args_text?).ok()?;
    tool_target(&args).map(|t| t.to_string_lossy())
}

/// `(v).toFixed(1)` — JavaScript picks the candidate nearest the true value
/// and, on an exact tie, the larger one; Rust's `{:.1}` rounds half to even,
/// so exact ties need a nudge. A tie needs `v * 10` exactly halfway between
/// two integers — `v * 20` an odd integer.
fn to_fixed_1(v: f64) -> String {
    let t20 = v * 20.0;
    if t20.is_finite() && t20.fract() == 0.0 && (t20 as i64) % 2 != 0 {
        let n = (t20 / 2.0).ceil();
        return format!("{:.1}", n / 10.0);
    }
    format!("{:.1}", v)
}

/// `formatToolDuration` — sub-second as `Nms`, else `N.Ns`.
pub fn format_tool_duration(duration_ms: Option<f64>) -> Option<String> {
    let ms = duration_ms?;
    if !ms.is_finite() || ms < 0.0 {
        return None;
    }
    // Math.round is half toward +∞, which is f64::round on the non-negative
    // inputs that reach this branch.
    Some(if ms < 1000.0 {
        format!("{}ms", ms.round() as i64)
    } else {
        format!("{}s", to_fixed_1(ms / 1000.0))
    })
}

/// Visual class of a tool call, for the kind icon on a CoT row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolKind {
    Shell,
    Search,
    Web,
    File,
    Edit,
    Tool,
}

impl ToolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolKind::Shell => "shell",
            ToolKind::Search => "search",
            ToolKind::Web => "web",
            ToolKind::File => "file",
            ToolKind::Edit => "edit",
            ToolKind::Tool => "tool",
        }
    }
}

/// `(name ?? "").trim().toLowerCase().replace(/-/g, "_")` — JS semantics:
/// trim uses the JS whitespace set, lowercasing is Unicode-aware.
pub fn normalize_tool_name(name: Option<&str>) -> String {
    let trimmed = name
        .unwrap_or("")
        .trim_matches(|c: char| (c as u32) <= 0xffff && crate::text::is_js_space(c as u16));
    let mut out = String::with_capacity(trimmed.len());
    for c in trimmed.chars() {
        for lc in c.to_lowercase() {
            out.push(lc);
        }
    }
    out.replace('-', "_")
}

/// `toolKindFromName` — map the well-known Pi builtins, generic wrench else.
pub fn tool_kind_from_name(name: Option<&str>) -> ToolKind {
    match normalize_tool_name(name).as_str() {
        "bash" | "shell" | "sh" | "terminal" | "cmd" => ToolKind::Shell,
        "grep" | "find" | "glob" | "ls" | "search" => ToolKind::Search,
        "web_search" | "websearch" | "webfetch" | "web_fetch" | "web" | "browser" => ToolKind::Web,
        "read" | "read_file" | "cat" => ToolKind::File,
        "edit" | "write" | "write_file" | "str_replace" => ToolKind::Edit,
        _ => ToolKind::Tool,
    }
}

/// `toolKindFromTools` — a burst of mixed kinds shares the generic wrench.
pub fn tool_kind_from_tools(tools: &[ToolItem]) -> ToolKind {
    let mut kinds = tools.iter().map(|tool| tool_kind_from_name(tool.tool_name.as_deref()));
    match kinds.next() {
        Some(first) if kinds.all(|kind| kind == first) => first,
        _ => ToolKind::Tool,
    }
}
