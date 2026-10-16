// Provider failure classification from
// packages/client/src/provider-failure.ts (itself from Pace's
// provider-auth.ts). The reference runs two regexes over the composed
// message; they are small alternations, so a tiny token matcher reproduces
// them rather than adding a regex dependency.
use crate::json::Json;
use crate::text;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderFailureKind {
    Auth,
    Entitlement,
    Network,
    Unknown,
}

impl ProviderFailureKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderFailureKind::Auth => "auth",
            ProviderFailureKind::Entitlement => "entitlement",
            ProviderFailureKind::Network => "network",
            ProviderFailureKind::Unknown => "unknown",
        }
    }
}

const NETWORK_CODES: [&str; 8] = [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
];

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `ownMessage`: a string is its own message; an object reads its `message`
/// property (`instanceof Error` never applies to decoded Json values).
fn own_message(error: &Json) -> Vec<u16> {
    if let Json::String(text) = error {
        return text.units().to_vec();
    }
    if error.is_container() {
        if let Some(message) = error.get("message").and_then(Json::as_str) {
            return message.units().to_vec();
        }
    }
    Vec::new()
}

struct Detail {
    status: Option<f64>,
    network_code: Option<Vec<u16>>,
    message: Vec<u16>,
}

/// `httpStatus` — `typeof` each candidate is "number" (NaN counts, like the
/// reference's typeof check).
fn http_status(error: &Json) -> Option<f64> {
    if let Some(v) = error.get("statusCode").and_then(Json::as_number) {
        return Some(v);
    }
    if let Some(v) = error.get("status").and_then(Json::as_number) {
        return Some(v);
    }
    // isRecord is `typeof === "object" && !== null` — arrays pass too, but a
    // numeric httpStatusCode can't live on one.
    if let Some(v) = error.get("$metadata").and_then(|m| m.get("httpStatusCode")).and_then(Json::as_number) {
        return Some(v);
    }
    error
        .get("$response")
        .and_then(|r| r.get("statusCode"))
        .and_then(Json::as_number)
}

/// `inspectProviderFailure`: the status/code/cause walk (depth-capped at 4).
fn inspect(error: Option<&Json>, depth: u8) -> Detail {
    if depth > 4 {
        return Detail {
            status: None,
            network_code: None,
            message: Vec::new(),
        };
    }
    let message = error.map(own_message).unwrap_or_default();
    // `!error || typeof error !== "object"` — falsy or non-object stops the
    // walk with just the message.
    let Some(record) = error.filter(|e| e.truthy() && (e.is_container())) else {
        return Detail {
            status: None,
            network_code: None,
            message,
        };
    };
    let status = http_status(record);
    let code = record
        .get("code")
        .and_then(Json::as_str)
        .filter(|code| NETWORK_CODES.iter().any(|known| code.units() == lit(known)))
        .map(|code| code.units().to_vec());
    let cause = inspect(record.get("cause"), depth + 1);
    let cause_message = if !cause.message.is_empty() && !text::contains(&message, &cause.message) {
        cause.message
    } else {
        Vec::new()
    };
    // `[message, causeMessage].filter(Boolean).join(" ")`.
    let mut joined = message;
    if !joined.is_empty() && !cause_message.is_empty() {
        joined.push(b' ' as u16);
    }
    joined.extend_from_slice(&cause_message);
    Detail {
        status: status.or(cause.status),
        network_code: code.or(cause.network_code),
        message: joined,
    }
}

// The token language the reference's regexes use: literals, `.`, `.?`, and
// alternation over those. Matchers are per-unit and case-insensitive where
// the reference's `/i` flag is.
#[derive(Clone, Copy)]
enum Tok {
    Lit(u16),
    OptLit(u16),
    OptAny,
}

fn toks(text: &str) -> Vec<Tok> {
    text.encode_utf16().map(Tok::Lit).collect()
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn matches_alt(units: &[u16], alt: &[Tok], pos: usize, depth: usize) -> bool {
    if depth == alt.len() {
        return true;
    }
    match alt[depth] {
        Tok::Lit(c) => {
            pos < units.len() && text::canon(units[pos]) == text::canon(c) && matches_alt(units, alt, pos + 1, depth + 1)
        }
        Tok::OptLit(c) => {
            (pos < units.len() && text::canon(units[pos]) == text::canon(c) && matches_alt(units, alt, pos + 1, depth + 1))
                || matches_alt(units, alt, pos, depth + 1)
        }
        Tok::OptAny => {
            (pos < units.len() && !is_line_terminator(units[pos]) && matches_alt(units, alt, pos + 1, depth + 1))
                || matches_alt(units, alt, pos, depth + 1)
        }
    }
}

fn test_anywhere(units: &[u16], alts: &[Vec<Tok>]) -> bool {
    (0..=units.len()).any(|start| alts.iter().any(|alt| matches_alt(units, alt, start, 0)))
}

fn opt_then(stem: &str, tail: &str) -> Vec<Tok> {
    // `stem.?tail` — one optional unit between the two literals.
    let mut tokens = toks(stem);
    tokens.push(Tok::OptAny);
    tokens.extend(toks(tail));
    tokens
}

/// RESOLVED_NETWORK_MESSAGE (case-insensitive).
fn network_message_alts() -> Vec<Vec<Tok>> {
    vec![
        opt_then("network", "error"),
        opt_then("connection", "error"),
        opt_then("connection", "refused"),
        opt_then("connection", "lost"),
        toks("other side closed"),
        toks("fetch failed"),
        toks("getaddrinfo"),
        toks("ENOTFOUND"),
        toks("EAI_AGAIN"),
        opt_then("upstream", "connect"),
        toks("reset before headers"),
        toks("socket hang up"),
        toks("socket connection was closed"),
        {
            // `timed? out` — the `?` applies to the `d`; the space is
            // mandatory. "time out" and "timed out" both match.
            let mut tokens = toks("time");
            tokens.push(Tok::OptLit(b'd' as u16));
            tokens.extend(toks(" out"));
            tokens
        },
        toks("timeout"),
        toks("terminated"),
        opt_then("websocket", "closed"),
        opt_then("websocket", "error"),
        toks("ended without"),
        toks("stream ended before message_stop"),
        toks("stream ended before a terminal response event"),
        toks("http2 request did not get a response"),
        toks("ECONNREFUSED"),
        toks("ETIMEDOUT"),
        toks("ECONNRESET"),
        toks("UND_ERR_"),
    ]
}

/// `/invalid.?api.?key|authentication_error|unauthorized/i`
fn invalid_auth_alts() -> Vec<Vec<Tok>> {
    let mut invalid = toks("invalid");
    invalid.push(Tok::OptAny);
    invalid.extend(toks("api"));
    invalid.push(Tok::OptAny);
    invalid.extend(toks("key"));
    vec![invalid, toks("authentication_error"), toks("unauthorized")]
}

/// `\b` in JS is a boundary between \w ([A-Za-z0-9_]) and non-\w.
fn is_word(unit: u16) -> bool {
    matches!(unit, 48..=57 | 65..=90 | 95 | 97..=122)
}

/// `\b(?:term1|term2|...)\b` — an exact literal bounded by non-word units.
fn has_bounded(units: &[u16], terms: &[&str], ignore_case: bool) -> bool {
    terms.iter().any(|term| {
        let lit = lit(term);
        if lit.len() > units.len() {
            return false;
        }
        (0..=units.len() - lit.len()).any(|start| {
            let hit = lit
                .iter()
                .enumerate()
                .all(|(i, &l)| {
                    if ignore_case {
                        text::canon(units[start + i]) == text::canon(l)
                    } else {
                        units[start + i] == l
                    }
                });
            hit
                && (start == 0 || !is_word(units[start - 1]))
                && (start + lit.len() >= units.len() || !is_word(units[start + lit.len()]))
        })
    })
}

fn kind_from_detail(detail: &Detail) -> ProviderFailureKind {
    // Status wins over prose.
    if detail.status == Some(401.0) || has_bounded(&detail.message, &["401"], false) {
        return ProviderFailureKind::Auth;
    }
    if detail.status == Some(403.0) || has_bounded(&detail.message, &["403"], false) {
        return ProviderFailureKind::Entitlement;
    }
    if has_bounded(&detail.message, &["plan", "subscription", "entitlement"], true) {
        return ProviderFailureKind::Entitlement;
    }
    // Network before auth prose: a refresh that never reached the provider
    // needs connectivity, not a new login.
    if detail.network_code.is_some() || test_anywhere(&detail.message, &network_message_alts()) {
        return ProviderFailureKind::Network;
    }
    if test_anywhere(&detail.message, &invalid_auth_alts())
        || test_anywhere(
            &detail.message,
            &[toks("invalid_grant"), toks("oauth refresh failed"), {
                let mut t = toks("refresh");
                t.push(Tok::OptAny);
                t.extend(toks("token"));
                t
            }],
        )
    {
        return ProviderFailureKind::Auth;
    }
    ProviderFailureKind::Unknown
}

/// `classifyProviderFailure`.
pub fn classify_provider_failure(error: &Json) -> ProviderFailureKind {
    kind_from_detail(&inspect(Some(error), 0))
}
