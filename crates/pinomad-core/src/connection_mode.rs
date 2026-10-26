// Connection mode shared with the TS coordinator and stored hosts (ADR-0033
// §3). A missing field means `Auto`, so old records keep their behaviour.
use crate::json::Json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionMode {
    Auto,
    DirectOnly,
    RelayOnly,
}

impl ConnectionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectionMode::Auto => "auto",
            ConnectionMode::DirectOnly => "directOnly",
            ConnectionMode::RelayOnly => "relayOnly",
        }
    }

    pub fn parse(value: Option<&Json>) -> Option<Self> {
        match value.and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() {
            Some("auto") => Some(ConnectionMode::Auto),
            Some("directOnly") => Some(ConnectionMode::DirectOnly),
            Some("relayOnly") => Some(ConnectionMode::RelayOnly),
            _ => None,
        }
    }
}
