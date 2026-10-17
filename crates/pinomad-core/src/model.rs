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
