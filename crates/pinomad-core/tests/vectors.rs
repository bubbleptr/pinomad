// Replays the generated comparison vectors (ADR-0024 §6) from
// packages/protocol/test/fixtures/rust-vectors/ — the TS reference computed
// the expectations; regenerate with PINOMAD_UPDATE_VECTORS=1.

use std::collections::HashMap;
use std::path::PathBuf;

use pinomad_core::delta::{apply_immutable, op_from_json, DeltaError, Op};
use pinomad_core::frames::{
    classify_server_frame, decode_server_frame, encode_client_frame, host_streams, host_supports_call,
    host_supports_feature, CallMethod, ClientFrame, HostFeature, ServerFrame, PROTOCOL,
};
use pinomad_core::json::Json;
use pinomad_core::pairing_link::{pairing_fragment, parse_pair_param};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/test/fixtures")
}

fn load(name: &str) -> Json {
    let text = std::fs::read_to_string(fixtures().join(format!("{name}.json")))
        .unwrap_or_else(|error| panic!("fixture {name}.json: {error}"));
    Json::parse(&text).unwrap_or_else(|error| panic!("fixture {name}.json parses: {error}"))
}

fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    value.get(key).expect(&format!("field {key} on {value:?}"))
}

fn as_text(value: &Json) -> String {
    value.as_str().expect("string").to_string_lossy()
}

fn variant(frame: &ServerFrame) -> &'static str {
    match frame {
        ServerFrame::Hello(_) => "hello",
        ServerFrame::Snapshot { .. } => "snapshot",
        ServerFrame::Ops { .. } => "ops",
        ServerFrame::Ended { .. } => "ended",
        ServerFrame::Result { .. } => "result",
        ServerFrame::Notice { .. } => "notice",
        ServerFrame::Ignored => "ignored",
    }
}

#[test]
fn server_frames_classify_like_the_reference() {
    let file = load("rust-vectors/frames");
    for case in field(&file, "serverFrames").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let wire = as_text(field(case, "wire"));
        let expect = as_text(field(case, "expect"));
        let frame = decode_server_frame(&wire).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(variant(&frame), expect, "{name}");
        if let Some(stream) = case.get("stream") {
            let stream = as_text(stream);
            let got = match &frame {
                ServerFrame::Snapshot { stream, .. } => stream.as_str().map(|s| s.to_string_lossy()),
                ServerFrame::Ops { stream, .. } => stream.as_str().map(|s| s.to_string_lossy()),
                ServerFrame::Ended { stream, .. } => stream.as_str().map(|s| s.to_string_lossy()),
                _ => None,
            };
            assert_eq!(got.as_deref(), Some(stream.as_str()), "{name}: stream");
        }
    }
}

#[test]
fn invalid_json_is_rejected() {
    let file = load("rust-vectors/frames");
    for bad in field(&file, "badJson").as_array().unwrap().iter() {
        let text = as_text(bad);
        assert!(Json::parse(&text).is_err(), "accepted {text:?}");
    }
}

#[test]
fn client_frames_encode_byte_identical() {
    let file = load("rust-vectors/frames");
    for case in field(&file, "clientFrames").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let expect = as_text(field(case, "wire"));
        // The wire text is ground truth: parse it back and re-emit through
        // the typed encoder.
        let decoded = Json::parse(&expect).unwrap();
        let kind = decoded.get("type").unwrap().as_str().unwrap().to_string_lossy();
        let frame = match kind.as_str() {
            "subscribe" => ClientFrame::Subscribe {
                stream: decoded.get("stream").unwrap().as_str().unwrap().clone(),
                images: decoded.get("images").and_then(Json::as_str).map(|v| v.to_string_lossy()) == Some("ref".to_string()),
            },
            "unsubscribe" => ClientFrame::Unsubscribe {
                stream: decoded.get("stream").unwrap().as_str().unwrap().clone(),
            },
            "call" => ClientFrame::Call {
                id: decoded.get("id").unwrap().as_number().unwrap(),
                method: decoded.get("method").unwrap().as_str().unwrap().clone(),
                args: decoded.get("args").unwrap().clone(),
            },
            other => panic!("{name}: unexpected client frame type {other}"),
        };
        assert_eq!(encode_client_frame(&frame), expect, "{name}");
    }
}

fn feature_of(name: &str) -> HostFeature {
    match name {
        "images" => HostFeature::Images,
        "acceptAccountDevices" => HostFeature::AcceptAccountDevices,
        "apnsPush" => HostFeature::ApnsPush,
        "agentConversations" => HostFeature::AgentConversations,
        "liveBranch" => HostFeature::LiveBranch,
        "hostName" => HostFeature::HostName,
        "imageRefs" => HostFeature::ImageRefs,
        other => panic!("unknown feature {other}"),
    }
}

/// The protocol version and every complete gate table the TS reference
/// generated — Rust must know every row and flip at the same minor, including
/// calls that date from 5.0.
#[test]
fn protocol_and_version_gates_agree_with_the_reference() {
    let file = load("rust-vectors/frames");
    let protocol = field(&file, "protocol");
    assert_eq!(
        PROTOCOL.major,
        field(protocol, "major").as_number().unwrap() as u32,
        "protocol major"
    );
    assert_eq!(
        PROTOCOL.minor,
        field(protocol, "minor").as_number().unwrap() as u32,
        "protocol minor"
    );

    let gates = field(&file, "gates");
    for case in field(gates, "call").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let since = field(case, "since").as_number().unwrap() as u32;
        assert!(
            CallMethod::from_str(&name).is_some(),
            "{name}: CallMethod is missing a TS call"
        );
        assert!(host_supports_call(since, &name), "{name}@{since} should be supported");
        if since > 0 {
            assert!(
                !host_supports_call(since - 1, &name),
                "{name}@{} should predate the call",
                since - 1
            );
        }
    }
    // Unknown methods keep the historical 5.0 fallback (issue #165 behavior
    // preservation): they were supported at every minor before this change.
    assert!(host_supports_call(0, "not-a-protocol-call"));

    for case in field(gates, "stream").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let since = field(case, "since").as_number().unwrap() as u32;
        assert!(
            host_streams(since).contains(&name.as_str()),
            "{name}@{since} should be a host stream"
        );
        if since > 0 {
            assert!(
                !host_streams(since - 1).contains(&name.as_str()),
                "{name}@{} should predate the stream",
                since - 1
            );
        }
    }

    for case in field(gates, "feature").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let since = field(case, "since").as_number().unwrap() as u32;
        assert!(host_supports_feature(since, feature_of(&name)), "{name}@{since}");
        if since > 0 {
            assert!(
                !host_supports_feature(since - 1, feature_of(&name)),
                "{name}@{} should predate the feature",
                since - 1
            );
        }
    }

    for case in field(&file, "versionGates").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let minor = field(case, "minor").as_number().unwrap() as u32;
        let expect = field(case, "expect").truthy();
        let supported = if let Some(method) = case.get("call").and_then(Json::as_str) {
            host_supports_call(minor, &method.to_string_lossy())
        } else {
            host_supports_feature(minor, feature_of(&as_text(field(case, "feature"))))
        };
        assert_eq!(supported, expect, "{name}");
    }
}

#[test]
fn delta_cases_apply_like_the_reference() {
    let file = load("rust-vectors/delta");
    for case in field(&file, "cases").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let before = Json::parse(&as_text(field(case, "before"))).unwrap();
        let ops_json = Json::parse(&as_text(field(case, "ops"))).unwrap();
        let ops: Vec<Result<Op, DeltaError>> = ops_json
            .as_array()
            .unwrap()
            .iter()
            .map(op_from_json)
            .collect();
        if let Some(expected) = case.get("error") {
            let expected = as_text(expected);
            // A failed decode or a failed apply both surface as the recorded
            // error kind; a clean run is itself a bug in the vectors.
            let kind = ops
                .iter()
                .find_map(|op| op.clone().err())
                .or_else(|| {
                    let decoded: Vec<Op> = ops.iter().filter_map(|op| op.clone().ok()).collect();
                    apply_immutable(&before, &decoded).err()
                })
                .map(|error| match error {
                    DeltaError::UnsafePath(_) => "unsafe-path",
                    DeltaError::Path(_) => "path",
                    DeltaError::Type(_) => "type",
                });
            assert_eq!(kind.as_deref(), Some(expected.as_str()), "{name}");
            continue;
        }
        let decoded: Vec<Op> = ops
            .into_iter()
            .map(|op| op.unwrap_or_else(|error| panic!("{name}: op decode: {error}")))
            .collect();
        let after = apply_immutable(&before, &decoded).unwrap_or_else(|error| panic!("{name}: apply: {error}"));
        assert_eq!(after.to_json(), as_text(field(case, "after")), "{name}");
    }
}

#[test]
fn pairing_links_parse_like_the_reference() {
    let file = load("rust-vectors/pairing");
    for case in field(&file, "links").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let pasted = as_text(field(case, "pasted"));
        let expect = match case.get("expect") {
            Some(Json::String(s)) => Some(s.to_string_lossy()),
            _ => None,
        };
        assert_eq!(pairing_fragment(&pasted), expect, "{name}");
    }
    for case in field(&file, "params").as_array().unwrap().iter() {
        let name = as_text(field(case, "name"));
        let pair = as_text(field(case, "pair"));
        let expect = field(case, "expect").truthy();
        assert_eq!(parse_pair_param(&pair).is_some(), expect, "{name}");
    }
}

/// The recorded host conversation (ADR-0018 §5) replays through the frame
/// decoder and the delta applier end to end — every frame must classify and
/// every ops batch must apply.
#[test]
fn recorded_host_frames_parse_and_apply() {
    let frames = load("host-frames");
    let mut streams: HashMap<String, Json> = HashMap::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for raw in frames.as_array().unwrap().iter() {
        let frame = classify_server_frame(raw.clone());
        *counts.entry(variant(&frame)).or_default() += 1;
        match &frame {
            ServerFrame::Snapshot { stream, value } => {
                let name = stream.as_str().expect("snapshot stream").to_string_lossy();
                streams.insert(name, value.clone());
            }
            ServerFrame::Ops { stream, ops } => {
                let name = stream.as_str().expect("ops stream").to_string_lossy();
                let before = streams.get(&name).expect("ops after snapshot").clone();
                let decoded: Vec<Op> = ops
                    .as_array()
                    .expect("ops array")
                    .iter()
                    .map(op_from_json)
                    .collect::<Result<_, _>>()
                    .expect("ops decode");
                let after = apply_immutable(&before, &decoded).expect("ops apply");
                streams.insert(name, after);
            }
            _ => {}
        }
    }
    assert_eq!(counts.get("hello"), Some(&1));
    assert_eq!(counts.get("ops"), Some(&19));
    assert_eq!(counts.get("snapshot"), Some(&14));
    assert_eq!(counts.get("result"), Some(&1));
    // The recorded conversation's final state is fully formed JSON — spot
    // check the shape the client relies on.
    let conversation = streams
        .get("conversation:4")
        .expect("conversation stream applied");
    assert!(conversation.is_object());
    let entries = conversation.get("entries").and_then(Json::as_array);
    assert!(entries.is_some_and(|entries| !entries.is_empty()));
}
