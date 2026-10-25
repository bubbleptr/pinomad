// Remote host endpoints (packages/protocol/src/endpoints.ts, issue #347,
// ADR-0032): the small, ordered list of sockets a host publishes. This
// module only models and validates the set; dialing order, retries and
// persistence belong to the client layers.

use std::collections::HashMap;
use std::sync::Arc;

use url::Url;

use crate::json::{Json, JsonObject};
use crate::u16str::U16String;

/// The only endpoint-set schema this build understands.
pub const ENDPOINT_SET_SCHEMA_VERSION: u32 = 1;

/// Upper bounds shared with the reference; generators must not truncate.
pub const MAX_ENDPOINTS: usize = 4;
pub const MAX_ENDPOINT_URL_LENGTH: usize = 1024;

/// The path role a socket plays. Tailscale and other providers are
/// transports, not roles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HostEndpointRole {
    Direct,
    Relay,
}

impl HostEndpointRole {
    pub fn as_str(self) -> &'static str {
        match self {
            HostEndpointRole::Direct => "direct",
            HostEndpointRole::Relay => "relay",
        }
    }
}

/// One socket the host publishes. Only WebSocket is supported today.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostEndpoint {
    pub role: HostEndpointRole,
    pub url: String,
}

impl HostEndpoint {
    fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        object.set(U16String::from_str("transport"), Json::from("webSocket"));
        object.set(U16String::from_str("role"), Json::from(self.role.as_str()));
        object.set(U16String::from_str("url"), Json::from(self.url.clone()));
        Json::Object(Arc::new(object))
    }
}

/// The host's remote candidates; an empty list means "no remote entry right now".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EndpointSet {
    pub schema_version: u32,
    pub endpoints: Vec<HostEndpoint>,
}

impl EndpointSet {
    /// The canonical JSON shape (the reference's object key order).
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        object.set(
            U16String::from_str("schemaVersion"),
            Json::Number(self.schema_version as f64),
        );
        object.set(
            U16String::from_str("endpoints"),
            Json::array(self.endpoints.iter().map(HostEndpoint::to_json).collect()),
        );
        Json::Object(Arc::new(object))
    }
}

/// How a raw endpoint set reads; callers decide what each outcome means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedEndpointSet {
    Absent,
    Unsupported,
    Malformed,
    Valid(EndpointSet),
}

fn is_socket_url(url: &str) -> bool {
    match Url::parse(url) {
        Ok(parsed) => parsed.scheme() == "ws" || parsed.scheme() == "wss",
        Err(_) => false,
    }
}

/// Validate an endpoint set from JSON. Unknown schema versions and sets with
/// no supported transport are ignored as a whole; a malformed set under the
/// current schema is rejected rather than partly adopted.
pub fn parse_endpoint_set(value: Option<&Json>) -> ParsedEndpointSet {
    let Some(value) = value else {
        return ParsedEndpointSet::Absent;
    };
    if !value.is_object() {
        return ParsedEndpointSet::Malformed;
    }
    let Some(version) = value.get("schemaVersion").and_then(Json::as_number) else {
        return ParsedEndpointSet::Malformed;
    };
    if version != ENDPOINT_SET_SCHEMA_VERSION as f64 {
        return ParsedEndpointSet::Unsupported;
    }
    let Some(raw) = value.get("endpoints").and_then(Json::as_array) else {
        return ParsedEndpointSet::Malformed;
    };
    if raw.len() > MAX_ENDPOINTS {
        return ParsedEndpointSet::Malformed;
    }
    let mut endpoints = Vec::new();
    let mut roles: HashMap<String, HostEndpointRole> = HashMap::new();
    for entry in raw.iter() {
        if !entry.is_object() {
            return ParsedEndpointSet::Malformed;
        }
        let Some(transport) = entry.get("transport").and_then(Json::as_str) else {
            return ParsedEndpointSet::Malformed;
        };
        // A future transport is not a reason to reject the set: keep the
        // entries this build can dial. "No supported entry" means unsupported.
        if transport.to_string_lossy() != "webSocket" {
            continue;
        }
        let role = match entry
            .get("role")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .as_deref()
        {
            Some("direct") => HostEndpointRole::Direct,
            Some("relay") => HostEndpointRole::Relay,
            _ => return ParsedEndpointSet::Malformed,
        };
        let Some(url) = entry.get("url").and_then(Json::as_str) else {
            return ParsedEndpointSet::Malformed;
        };
        // JavaScript's string length counts UTF-16 code units — the emoji
        // case keeps the two implementations on the same limit.
        if url.units().len() > MAX_ENDPOINT_URL_LENGTH {
            return ParsedEndpointSet::Malformed;
        }
        let url = url.to_string_lossy();
        if !is_socket_url(&url) {
            return ParsedEndpointSet::Malformed;
        }
        match roles.get(&url) {
            Some(prior) if *prior != role => return ParsedEndpointSet::Malformed,
            Some(_) => continue,
            None => {
                roles.insert(url.clone(), role);
                endpoints.push(HostEndpoint { role, url });
            }
        }
    }
    // No supported entry is not the same as an explicit empty set: the
    // former is a set this build cannot use, the latter is a host declaring
    // no remote entry.
    if endpoints.is_empty() && !raw.is_empty() {
        return ParsedEndpointSet::Unsupported;
    }
    ParsedEndpointSet::Valid(EndpointSet {
        schema_version: ENDPOINT_SET_SCHEMA_VERSION,
        endpoints,
    })
}

/// Validate a decoded `endpointSet` query value.
pub fn parse_endpoint_set_text(text: &str) -> ParsedEndpointSet {
    match Json::parse(text) {
        Ok(value) => parse_endpoint_set(Some(&value)),
        Err(_) => ParsedEndpointSet::Malformed,
    }
}
