// The model types shared by the conversation's agent state and the model-
// picker derivations (packages/client/src/model.ts) — selector text,
// filtering and draft reconciliation, shared by every client.

use crate::json::Json;
use crate::text;
use crate::u16str::U16String;

/// `ThinkingLevel` — pi-ai's `ModelThinkingLevel`. The set is fixed upstream;
/// an `Other` keeps a level a newer host invented (the reference passes it
/// through as a string).
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Other(String),
}

impl ThinkingLevel {
    /// `off` first — the ordering `clampLevel` relies on.
    pub const ORDER: &'static [&'static str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    pub fn as_str(&self) -> &str {
        match self {
            ThinkingLevel::Off => "off",
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Low => "low",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::High => "high",
            ThinkingLevel::Xhigh => "xhigh",
            ThinkingLevel::Max => "max",
            ThinkingLevel::Other(value) => value.as_str(),
        }
    }

    /// `LEVELS.indexOf(level)` — -1 for an unknown level, like the reference.
    fn rank(&self) -> i64 {
        Self::ORDER
            .iter()
            .position(|level| *level == self.as_str())
            .map(|i| i as i64)
            .unwrap_or(-1)
    }

    /// From a JSON string value (unit-exact compare).
    pub fn from_units(units: &[u16]) -> ThinkingLevel {
        match units {
            u if *u == lit("off") => ThinkingLevel::Off,
            u if *u == lit("minimal") => ThinkingLevel::Minimal,
            u if *u == lit("low") => ThinkingLevel::Low,
            u if *u == lit("medium") => ThinkingLevel::Medium,
            u if *u == lit("high") => ThinkingLevel::High,
            u if *u == lit("xhigh") => ThinkingLevel::Xhigh,
            u if *u == lit("max") => ThinkingLevel::Max,
            other => ThinkingLevel::Other(U16String(other.to_vec()).to_string_lossy()),
        }
    }
}

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `ModelRef` — `{provider, modelId}`.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ModelRef {
    pub provider: String,
    pub model_id: String,
}

impl ModelRef {
    /// Both fields present and strings — otherwise the reference's reads
    /// would see undefined and `sameModel` would report false anyway.
    pub fn from_json(value: &Json) -> Option<Self> {
        Some(ModelRef {
            provider: value.get("provider").and_then(Json::as_str)?.to_string_lossy(),
            model_id: value.get("modelId").and_then(Json::as_str)?.to_string_lossy(),
        })
    }

    pub fn to_json(&self) -> Json {
        let mut object = crate::json::JsonObject::new();
        object.set(U16String::from_str("provider"), Json::String(U16String::from_str(&self.provider)));
        object.set(U16String::from_str("modelId"), Json::String(U16String::from_str(&self.model_id)));
        Json::Object(std::sync::Arc::new(object))
    }
}

/// The picker's selection state: a model ref plus a thinking level.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ModelPick {
    pub model: Option<ModelRef>,
    pub level: ThinkingLevel,
}

/// `ModelSummary` — a host-advertised model with its display metadata. The
/// decode is lenient (fields empty when absent): `filterModels` hands entries
/// back verbatim and `summaryOf` matches on the raw pair, so malformed rows
/// keep flowing like the reference. `raw` covers emission and the fields this
/// decode does not surface.
#[derive(Clone, Debug)]
pub struct ModelSummary {
    pub provider: String,
    pub model_id: String,
    pub name: Option<String>,
    pub context_window: Option<f64>,
    /// Whether the model accepts image input (pi-ai `input` includes "image");
    /// absent from pre-5.5 hosts.
    pub supports_images: Option<bool>,
    raw: Json,
}

impl ModelSummary {
    /// An entry as the host sent it — fields decode leniently ("" when the
    /// value is absent or not a string).
    pub fn from_json(value: &Json) -> Self {
        ModelSummary {
            provider: value.get("provider").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default(),
            model_id: value.get("modelId").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default(),
            name: value.get("name").and_then(Json::as_str).map(|s| s.to_string_lossy()),
            context_window: value.get("contextWindow").and_then(Json::as_number),
            // The wire field is `images` (view.ts ModelSummary.images) —
            // reading `supportsImages` here decoded nothing.
            supports_images: match value.get("images") {
                Some(Json::Bool(b)) => Some(*b),
                _ => None,
            },
            raw: value.clone(),
        }
    }

    /// The entry verbatim — `filterModels` returns summary objects.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }

    /// `thinkingLevels` — levels the model supports; a non-array value reads
    /// as none.
    pub fn thinking_levels(&self) -> Vec<ThinkingLevel> {
        self.raw
            .get("thinkingLevels")
            .and_then(Json::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|l| l.as_str().map(|s| ThinkingLevel::from_units(s.units())))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// `thinkingLevelLabels[level]` — `None` for an unknown level (the reference
/// emits `undefined` then).
pub fn thinking_level_label(level: &ThinkingLevel) -> Option<String> {
    Some(
        match level {
            ThinkingLevel::Off => "Off",
            ThinkingLevel::Minimal => "Minimal",
            ThinkingLevel::Low => "Low",
            ThinkingLevel::Medium => "Medium",
            ThinkingLevel::High => "High",
            ThinkingLevel::Xhigh => "X-High",
            ThinkingLevel::Max => "Max",
            ThinkingLevel::Other(_) => return None,
        }
        .to_string(),
    )
}

/// `sameModel`: strict provider + modelId equality, defined refs only.
pub fn same_model(a: Option<ModelRef>, b: Option<ModelRef>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.provider == b.provider && a.model_id == b.model_id,
        _ => false,
    }
}

/// `clampLevel`: keep `want` when supported, else the highest supported level
/// not above it, else "off". Unknown levels sort at indexOf -1, like the
/// reference — an unknown supported level can still be picked when `want` is
/// itself unknown.
pub fn clamp_level(levels: &[ThinkingLevel], want: &ThinkingLevel) -> ThinkingLevel {
    if levels.iter().any(|level| level == want) {
        return want.clone();
    }
    let want_index = want.rank();
    levels
        .iter()
        .rev()
        .find(|level| level.rank() <= want_index)
        .cloned()
        .unwrap_or(ThinkingLevel::Off)
}

/// `m.provider === ref.provider && m.modelId === ref.modelId` — `===` is
/// strict: a non-string field never matches. The ref's fields crossed the
/// String boundary already, so compare both sides post-lossy.
fn entry_matches(entry: &Json, model_ref: &ModelRef) -> bool {
    entry
        .get("provider")
        .and_then(Json::as_str)
        .is_some_and(|p| p.to_string_lossy() == model_ref.provider)
        && entry
            .get("modelId")
            .and_then(Json::as_str)
            .is_some_and(|id| id.to_string_lossy() == model_ref.model_id)
}

/// `summaryOf`: the first listed model matching the ref exactly.
pub fn summary_of(models: &[Json], model_ref: Option<ModelRef>) -> Option<ModelSummary> {
    let model_ref = model_ref?;
    models
        .iter()
        .find(|each| entry_matches(each, &model_ref))
        .map(ModelSummary::from_json)
}

/// `${provider}/${modelId}` in the reference's template — `String(value)` per
/// part.
fn ref_text(model: &Json) -> Vec<u16> {
    let mut out = text::string_of(model.get("provider"));
    out.push(b'/' as u16);
    out.extend_from_slice(&text::string_of(model.get("modelId")));
    out
}

/// `modelLabel`: "Name · Level" when the model reasons, else just the name.
pub fn model_label(models: &[Json], selected: ModelPick) -> String {
    let summary = models
        .iter()
        .find(|each| selected.model.as_ref().is_some_and(|m| entry_matches(each, m)));
    // `summary?.name ?? selected.model?.modelId ?? "No model"` — each `??`
    // step is nullish; a present non-string name renders via String().
    let name = summary
        .and_then(|s| s.get("name"))
        .filter(|n| !matches!(n, Json::Null))
        .map(|n| U16String::js_string(n).0)
        .or_else(|| {
            selected
                .model
                .as_ref()
                .map(|m| m.model_id.encode_utf16().collect::<Vec<u16>>())
        })
        .unwrap_or_else(|| "No model".encode_utf16().collect::<Vec<u16>>());
    // `summary?.thinkingLevels ?? ["off"]`: a non-array keeps its own .length
    // — a string's length counts, an object's is undefined (> 1 is false).
    let multi = match summary.and_then(|s| s.get("thinkingLevels")) {
        Some(Json::Array(levels)) => levels.len() > 1,
        Some(Json::String(text)) => text.units().len() > 1,
        _ => false,
    };
    if !multi {
        return U16String(name).to_string_lossy();
    }
    let label = thinking_level_label(&selected.level).unwrap_or_else(|| "undefined".to_string());
    let mut out = name;
    out.extend_from_slice(&" · ".encode_utf16().collect::<Vec<u16>>());
    out.extend_from_slice(&label.encode_utf16().collect::<Vec<u16>>());
    U16String(out).to_string_lossy()
}

/// `filterModels`: case-insensitive substring match on the display name or
/// provider/modelId. `includes` is a unit-level search, so non-BMP text
/// behaves like the reference.
pub fn filter_models(models: &[Json], query: &str) -> Vec<ModelSummary> {
    let needle = text::to_lowercase(text::trim(&query.encode_utf16().collect::<Vec<u16>>()));
    let all = || models.iter().map(ModelSummary::from_json).collect();
    if needle.is_empty() {
        return all();
    }
    let hit = |units: &[u16]| text::contains(&text::to_lowercase(units), &needle);
    models
        .iter()
        .filter(|model| {
            let name_hit = model
                .get("name")
                .and_then(Json::as_str)
                .is_some_and(|name| hit(name.units()));
            name_hit || hit(&ref_text(model))
        })
        .map(ModelSummary::from_json)
        .collect()
}

/// `reconcileDraftPick`: remembered if still listed → the host default → the
/// first model → none; the level clamps to the resolved model.
pub fn reconcile_draft_pick(models: &[Json], defaults: Option<&Json>, remembered: ModelPick) -> ModelPick {
    let remembered_model = remembered
        .model
        .as_ref()
        .filter(|m| models.iter().any(|each| entry_matches(each, m)))
        .cloned();
    let default_model = defaults
        .and_then(|d| d.get("model"))
        .and_then(ModelRef::from_json)
        .filter(|m| models.iter().any(|each| entry_matches(each, m)));
    let model = remembered_model.or(default_model).or_else(|| {
        models.first().map(|first| ModelRef {
            // `String(provider)`/`String(modelId)` — the reference coerces.
            provider: U16String(text::string_of(first.get("provider"))).to_string_lossy(),
            model_id: U16String(text::string_of(first.get("modelId"))).to_string_lossy(),
        })
    });
    let summary = models
        .iter()
        .find(|each| model.as_ref().is_some_and(|m| entry_matches(each, m)));
    // `summary?.thinkingLevels ?? ["off"]` — a non-array value would make the
    // reference throw; degrade to the same ["off"] fallback.
    let levels: Vec<ThinkingLevel> = summary
        .and_then(|s| s.get("thinkingLevels"))
        .and_then(Json::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|l| l.as_str().map(|s| ThinkingLevel::from_units(s.units())))
                .collect()
        })
        .unwrap_or_else(|| vec![ThinkingLevel::Off]);
    ModelPick {
        model,
        level: clamp_level(&levels, &remembered.level),
    }
}

// ─── Named-agent drafts (ADR-0023) ─────────────────────────────────────────

/// `AgentDraftSource` — which layer a shown value came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AgentDraftSource {
    Agent,
    Default,
    Override,
}

impl AgentDraftSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentDraftSource::Agent => "agent",
            AgentDraftSource::Default => "default",
            AgentDraftSource::Override => "override",
        }
    }
}

/// `AgentDraftProblem` — why the host would refuse the create, checked before
/// anything is sent.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AgentDraftProblem {
    /// The name is not in the snapshot's roles (deleted, or its file failed
    /// to load — `reason` carries the load error).
    AgentMissing { agent: String, reason: Option<String> },
    /// Nothing resolved to a model: no override, no role pin, no host default.
    ModelMissing { agent: String },
    /// The effective model — whichever source it came from — is not in the
    /// host's advertised list.
    ModelUnavailable {
        agent: String,
        model: ModelRef,
        source: AgentDraftSource,
    },
}

/// `AgentDraftResolution` — display values, their sources, the send args and
/// the blocking problem.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AgentDraft {
    /// Display: the effective model; `None` when none resolves (a
    /// `ModelMissing` problem).
    pub model: Option<ModelRef>,
    /// Display: the effective level, clamped to the shown model only when it
    /// is listed — as the host does.
    pub level: ThinkingLevel,
    /// Which layer each shown value came from; `model_from` is `None` when no
    /// model resolved.
    pub model_from: Option<AgentDraftSource>,
    pub level_from: AgentDraftSource,
    /// `createConversation` options beyond `agent`: only the user's
    /// overrides — inherited values resolve host-side.
    pub send_model: Option<ModelRef>,
    pub send_level: Option<ThinkingLevel>,
    /// Why sending would fail at the host; the composer blocks submit on it.
    pub problem: Option<AgentDraftProblem>,
}

/// The `slice(0, -1)`/`slice(0)` shape of JS `indexOf("/")` returning -1 —
/// unit-level, like the reference.
fn split_role_model(model: &str) -> ModelRef {
    let units: Vec<u16> = model.encode_utf16().collect();
    let slash = units.iter().position(|unit| *unit == b'/' as u16);
    let (provider, id) = match slash {
        Some(i) => (&units[..i], &units[i + 1..]),
        None => (&units[..units.len().saturating_sub(1)], &units[..]),
    };
    ModelRef {
        provider: U16String(provider.to_vec()).to_string_lossy(),
        model_id: U16String(id.to_vec()).to_string_lossy(),
    }
}

fn str_of(json: Option<&Json>) -> Option<String> {
    json.and_then(Json::as_str).map(|s| s.to_string_lossy())
}

fn level_of(json: Option<&Json>) -> Option<ThinkingLevel> {
    json.and_then(Json::as_str)
        .map(|s| ThinkingLevel::from_units(s.units()))
}

/// `resolveAgentDraft`: the draft's model/level resolution once a named agent
/// is picked — override > role pin > host default, the same chain the host
/// runs at `createConversation`. No first-model fallback.
pub fn resolve_agent_draft(
    agent: &str,
    agents: Option<&Json>,
    models: &[Json],
    defaults: Option<&Json>,
    overrides: &Json,
) -> AgentDraft {
    let agent_units: Vec<u16> = agent.encode_utf16().collect();
    let role = agents
        .and_then(|a| a.get("roles"))
        .and_then(Json::as_array)
        .and_then(|roles| {
            roles.iter().find(|role| {
                role.get("name")
                    .and_then(Json::as_str)
                    .is_some_and(|name| name.units() == agent_units.as_slice())
            })
        });
    let role_model = role
        .and_then(|role| role.get("model"))
        .and_then(Json::as_str)
        .map(|model| split_role_model(&model.to_string_lossy()));
    let role_level = role.and_then(|role| level_of(role.get("thinkingLevel")));
    let override_model = overrides.get("model").and_then(ModelRef::from_json);
    let override_level = level_of(overrides.get("level"));
    let default_model = defaults.and_then(|d| d.get("model")).and_then(ModelRef::from_json);
    let default_level = defaults.and_then(|d| level_of(d.get("thinkingLevel")));

    let model = override_model.clone().or_else(|| role_model.clone()).or(default_model);
    let model_from = if override_model.is_some() {
        Some(AgentDraftSource::Override)
    } else if role_model.is_some() {
        Some(AgentDraftSource::Agent)
    } else {
        model.as_ref().map(|_| AgentDraftSource::Default)
    };
    let level_from = if override_level.is_some() {
        AgentDraftSource::Override
    } else if role_level.is_some() {
        AgentDraftSource::Agent
    } else {
        AgentDraftSource::Default
    };
    let want = override_level.clone().or(role_level).or(default_level).unwrap_or(ThinkingLevel::Off);
    let summary = model.as_ref().and_then(|m| summary_of(models, Some(m.clone())));
    // The host clamps only when the effective model resolves; an unlisted or
    // missing model leaves the inherited level untouched (the create fails
    // anyway).
    let level = summary
        .as_ref()
        .map(|summary| clamp_level(&summary.thinking_levels(), &want))
        .unwrap_or(want);
    let reason = role.is_none().then(|| {
        agents
            .and_then(|a| a.get("problems"))
            .and_then(Json::as_array)
            .and_then(|problems| {
                let file: Vec<u16> = format!("{agent}.md").encode_utf16().collect();
                problems.iter().find(|problem| {
                    problem
                        .get("file")
                        .and_then(Json::as_str)
                        .is_some_and(|f| f.units() == file.as_slice())
                })
            })
            .and_then(|problem| str_of(problem.get("reason")))
    }).flatten();
    let problem = if role.is_none() {
        Some(AgentDraftProblem::AgentMissing {
            agent: agent.to_string(),
            reason,
        })
    } else if model.is_none() {
        Some(AgentDraftProblem::ModelMissing {
            agent: agent.to_string(),
        })
    } else if summary.is_none() {
        Some(AgentDraftProblem::ModelUnavailable {
            agent: agent.to_string(),
            model: model.clone().unwrap(),
            source: model_from.unwrap(),
        })
    } else {
        None
    };
    AgentDraft {
        model,
        level,
        model_from,
        level_from,
        send_model: override_model,
        send_level: override_level,
        problem,
    }
}
