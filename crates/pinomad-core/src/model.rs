// The model types shared by the conversation's agent state and the model-
// picker derivations (packages/client/src/model.ts). The derivation functions
// themselves were added alongside their vector coverage.

use crate::json::Json;
use crate::u16str::U16String;

/// `ThinkingLevel` — pi-ai's `ModelThinkingLevel`. The set is fixed upstream;
/// an `Other` keeps a level a newer host invented (the reference passes it
/// through as a string).
#[derive(Clone, Debug, PartialEq, Eq)]
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

    pub fn rank(&self) -> Option<usize> {
        Self::ORDER.iter().position(|level| *level == self.as_str())
    }

    /// From a JSON string value (unit-exact compare).
    pub fn from_units(units: &[u16]) -> Option<ThinkingLevel> {
        Some(match units {
            u if *u == lit("off") => ThinkingLevel::Off,
            u if *u == lit("minimal") => ThinkingLevel::Minimal,
            u if *u == lit("low") => ThinkingLevel::Low,
            u if *u == lit("medium") => ThinkingLevel::Medium,
            u if *u == lit("high") => ThinkingLevel::High,
            u if *u == lit("xhigh") => ThinkingLevel::Xhigh,
            u if *u == lit("max") => ThinkingLevel::Max,
            other => ThinkingLevel::Other(U16String(other.to_vec()).to_string_lossy()),
        })
    }
}

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `ModelRef` — `{provider, modelId}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: String,
    pub model_id: String,
}

impl ModelRef {
    /// Both fields present and strings — otherwise the reference's reads
    /// would see undefined.
    pub fn from_json(value: &Json) -> Option<Self> {
        Some(ModelRef {
            provider: value.get("provider").and_then(Json::as_str)?.to_string_lossy(),
            model_id: value.get("modelId").and_then(Json::as_str)?.to_string_lossy(),
        })
    }

    pub fn to_json(&self) -> Json {
        let mut object = crate::json::JsonObject::new();
        object.set(
            U16String::from_str("provider"),
            Json::String(U16String::from_str(&self.provider)),
        );
        object.set(
            U16String::from_str("modelId"),
            Json::String(U16String::from_str(&self.model_id)),
        );
        Json::Object(std::rc::Rc::new(object))
    }
}

/// The picker's selection state: a model ref plus a thinking level.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelPick {
    pub model: Option<ModelRef>,
    pub level: ThinkingLevel,
}

/// `ModelSummary` — a host-advertised model with its display metadata.
/// `raw` keeps fields this decode does not surface. Only the `ModelRef` pair
/// identifies the entry — `summaryOf` matches on those alone, so `name` and
/// the rest stay optional.
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
    /// A model entry, or None when the identifying ref fields are missing.
    pub fn from_json(value: &Json) -> Option<Self> {
        Some(ModelSummary {
            provider: value.get("provider").and_then(Json::as_str)?.to_string_lossy(),
            model_id: value.get("modelId").and_then(Json::as_str)?.to_string_lossy(),
            name: value.get("name").and_then(Json::as_str).map(|s| s.to_string_lossy()),
            context_window: value.get("contextWindow").and_then(Json::as_number),
            supports_images: match value.get("supportsImages") { Some(Json::Bool(b)) => Some(*b), _ => None },
            raw: value.clone(),
        })
    }

    /// The entry verbatim — `filterModels` returns summary objects.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }

    /// `thinkingLevels` — levels the model supports.
    pub fn thinking_levels(&self) -> Vec<ThinkingLevel> {
        self.raw
            .get("thinkingLevels")
            .and_then(Json::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|l| l.as_str().and_then(|s| ThinkingLevel::from_units(s.units())))
                    .collect()
            })
            .unwrap_or_default()
    }
}
