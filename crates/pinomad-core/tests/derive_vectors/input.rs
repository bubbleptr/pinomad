// Test-only decode of the typed output shapes the vectors carry back in as
// inputs (splitSubagentCalls' CotView, toolKindFromTools' items).
use pinomad_core::cot_view::{CotAnswer, CotPhase, CotStep, CotView};
use pinomad_core::json::Json;
use pinomad_core::tool_item::{MessageImage, PinomadToolDetail, ToolItem, ToolPartState, DiffStat};

fn text(value: Option<&Json>) -> Option<String> {
    value.and_then(Json::as_str).map(|s| s.to_string_lossy())
}

fn num(value: Option<&Json>) -> Option<f64> {
    value.and_then(Json::as_number)
}

fn state(value: Option<&Json>) -> ToolPartState {
    match value.and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() {
        Some("input-streaming") => ToolPartState::InputStreaming,
        Some("output-available") => ToolPartState::OutputAvailable,
        Some("output-error") => ToolPartState::OutputError,
        _ => ToolPartState::InputAvailable,
    }
}

fn image(json: &Json) -> MessageImage {
    MessageImage {
        data: text(json.get("data")).unwrap_or_default(),
        mime_type: text(json.get("mimeType")).unwrap_or_default(),
        ref_: text(json.get("ref")),
    }
}

fn diff_stat(json: &Json) -> DiffStat {
    DiffStat {
        additions: num(json.get("additions")).unwrap_or(0.0),
        deletions: num(json.get("deletions")).unwrap_or(0.0),
    }
}

fn pinomad(json: &Json) -> Option<PinomadToolDetail> {
    match json.get("kind").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() {
        Some("diff") => Some(PinomadToolDetail::Diff {
            patch: text(json.get("patch")).unwrap_or_default(),
        }),
        Some("subagent") => Some(PinomadToolDetail::Subagent {
            conversation_id: pinomad_core::json::num_key(json.get("conversationId")).unwrap_or(u64::MAX),
            output: text(json.get("output")),
            model: text(json.get("model")),
            started_at: num(json.get("startedAt")),
            ended_at: num(json.get("endedAt")),
        }),
        _ => None,
    }
}

pub fn tool(json: &Json) -> ToolItem {
    ToolItem {
        state: state(json.get("state")),
        tool_call_id: text(json.get("toolCallId")),
        tool_name: text(json.get("toolName")),
        args_text: text(json.get("argsText")),
        output: text(json.get("output")),
        diff_stat: json.get("diffStat").map(diff_stat),
        duration_ms: num(json.get("durationMs")),
        images: json
            .get("images")
            .and_then(Json::as_array)
            .map(|items| items.iter().map(image).collect())
            .unwrap_or_default(),
        children: json
            .get("children")
            .and_then(Json::as_array)
            .map(|items| items.iter().map(tool).collect())
            .unwrap_or_default(),
        pinomad: json.get("pinomad").and_then(pinomad),
    }
}

fn step(json: &Json) -> CotStep {
    match json.get("kind").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() {
        Some("thinking") => CotStep::Thinking {
            id: text(json.get("id")).unwrap_or_default(),
            text: text(json.get("text")).unwrap_or_default(),
            live: json.get("live").is_some_and(Json::truthy),
        },
        Some("interim") => CotStep::Interim {
            id: text(json.get("id")).unwrap_or_default(),
            text: text(json.get("text")).unwrap_or_default(),
        },
        _ => CotStep::Tools {
            id: text(json.get("id")).unwrap_or_default(),
            tools: json
                .get("tools")
                .and_then(Json::as_array)
                .map(|items| items.iter().map(tool).collect())
                .unwrap_or_default(),
            live: json.get("live").is_some_and(Json::truthy),
            active_tool_call_id: text(json.get("activeToolCallId")),
        },
    }
}

pub fn cot(json: &Json) -> CotView {
    CotView {
        phase: match json.get("phase").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() {
            Some("hidden") => CotPhase::Hidden,
            Some("thinking") => CotPhase::Thinking,
            Some("acting") => CotPhase::Acting,
            Some("answering") => CotPhase::Answering,
            _ => CotPhase::Settled,
        },
        failed: json
            .get("outcome")
            .and_then(Json::as_str)
            .is_some_and(|s| s.to_string_lossy() == "failed"),
        anchor_ms: num(json.get("anchorMs")),
        elapsed_ms: num(json.get("elapsedMs")),
        todo_written_at_ms: num(json.get("todoWrittenAtMs")),
        steps: json
            .get("steps")
            .and_then(Json::as_array)
            .map(|items| items.iter().map(step).collect())
            .unwrap_or_default(),
        answer: json.get("answer").map(|a| CotAnswer {
            text: text(a.get("text")).unwrap_or_default(),
            streaming: a.get("streaming").is_some_and(Json::truthy),
        }),
    }
}

use pinomad_core::account::{AccountHost, AccountHostPairing, AccountOp, AccountOpKind, PairingOffer};
use pinomad_core::endpoints::{parse_endpoint_set, ParsedEndpointSet};
use pinomad_core::model::{ModelPick, ModelRef};
use pinomad_core::stored_host::StoredHost;

pub fn model_ref(json: &Json) -> Option<ModelRef> {
    ModelRef::from_json(json)
}

pub fn model_pick(json: &Json) -> ModelPick {
    ModelPick {
        model: json.get("model").and_then(ModelRef::from_json),
        level: json
            .get("level")
            .and_then(Json::as_str)
            .map(|s| pinomad_core::model::ThinkingLevel::from_units(s.units()))
            // `remembered.level` absent is `undefined` — an unknown level for
            // every rank comparison, like the reference sees it.
            .unwrap_or_else(|| pinomad_core::model::ThinkingLevel::Other("undefined".to_string())),
    }
}

pub fn stored_host(json: &Json) -> StoredHost {
    // The hosts passed to hostLabels are already parsed entries.
    StoredHost {
        url: text(json.get("url")).unwrap_or_default(),
        host_key: text(json.get("hostKey")).unwrap_or_default(),
        private_key: text(json.get("privateKey")).unwrap_or_default(),
        name: text(json.get("name")),
        account: None,
        endpoint_set: None,
        connection_mode: None,
        rtc_signal_only: None,
    }
}

/// The op the request-shape cases name: `{kind, username?, password?, hostId?}`.
pub fn account_op(json: &Json) -> AccountOp {
    match account_op_kind(&text(json.get("kind")).unwrap_or_default()) {
        AccountOpKind::Login => AccountOp::Login {
            username: text(json.get("username")).unwrap_or_default(),
            password: text(json.get("password")).unwrap_or_default(),
        },
        AccountOpKind::RequestPairing => AccountOp::RequestPairing {
            host_id: text(json.get("hostId")).unwrap_or_default(),
        },
        AccountOpKind::Me => AccountOp::Me,
        AccountOpKind::Logout => AccountOp::Logout,
        AccountOpKind::RevokeAllSessions => AccountOp::RevokeAllSessions,
        AccountOpKind::CreateJoinToken => AccountOp::CreateJoinToken,
        AccountOpKind::ListHosts => AccountOp::ListHosts,
    }
}

/// The op discriminant the response cases carry — the client's method names.
pub fn account_op_kind(name: &str) -> AccountOpKind {
    match name {
        "login" => AccountOpKind::Login,
        "me" => AccountOpKind::Me,
        "logout" => AccountOpKind::Logout,
        "revokeAllSessions" => AccountOpKind::RevokeAllSessions,
        "createJoinToken" => AccountOpKind::CreateJoinToken,
        "listHosts" => AccountOpKind::ListHosts,
        "requestPairing" => AccountOpKind::RequestPairing,
        other => panic!("unknown account op kind {other}"),
    }
}

/// A `GET /api/hosts` row — the same strict shape the response parser wants.
pub fn account_host(json: &Json) -> AccountHost {
    AccountHost {
        host_id: text(json.get("hostId")).unwrap_or_default(),
        name: text(json.get("name")).unwrap_or_default(),
        noise_public_key: text(json.get("noisePublicKey")).unwrap_or_default(),
        online: json.get("online").is_some_and(Json::truthy),
        last_seen_at: num(json.get("lastSeenAt")).unwrap_or_default(),
        pairing: match text(json.get("pairing")).as_deref() {
            Some("offline") => AccountHostPairing::Offline,
            Some("host_too_old") => AccountHostPairing::HostTooOld,
            Some("key_mismatch") => AccountHostPairing::KeyMismatch,
            _ => AccountHostPairing::Available,
        },
    }
}

/// `matchAccountHosts`'s stored inputs are the validated entries a client
/// would load back, so they decode through the same `parse_stored_host`.
pub fn stored_host_full(json: &Json) -> StoredHost {
    pinomad_core::stored_host::parse_stored_host(json).expect("match vector stored entry")
}

pub fn pairing_offer(json: &Json) -> PairingOffer {
    PairingOffer {
        url: text(json.get("url")).unwrap_or_default(),
        host_key: text(json.get("hostKey")).unwrap_or_default(),
        secret: text(json.get("secret")).unwrap_or_default(),
        expires_at: num(json.get("expiresAt")).unwrap_or_default(),
        endpoint_set: match parse_endpoint_set(json.get("endpointSet")) {
            ParsedEndpointSet::Valid(set) if !set.endpoints.is_empty() => Some(set),
            _ => None,
        },
    }
}
