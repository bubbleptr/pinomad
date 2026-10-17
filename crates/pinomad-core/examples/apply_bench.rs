// One-off timing for the incremental delta apply — before/after the
// Rc→Arc switch. Not a test; run manually:
//   cargo run --release -p pinomad-core --example apply_bench
//
// Two measures:
//  1. replay every `ops` frame recorded in host-frames.json through
//     op_from_json + apply_immutable on the live stream value;
//  2. a synthetic long conversation: 400 streamed text appends onto a
//     ~500-entry conversation view, the shape token streaming takes.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use pinomad_core::delta::{apply_immutable, op_from_json};
use pinomad_core::json::Json;

fn fixture() -> Json {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/test/fixtures/host-frames.json");
    Json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn ops_of(text: &str) -> Vec<pinomad_core::delta::Op> {
    Json::parse(text)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(op_from_json)
        .collect::<Result<_, _>>()
        .unwrap()
}

fn main() {
    let frames = fixture();
    // Track every stream's value; replay ops in recorded order.
    let mut values: std::collections::HashMap<String, Json> = std::collections::HashMap::new();
    let mut decode = Duration::ZERO;
    let mut apply = Duration::ZERO;
    let mut ops_frames = 0u32;
    let mut ops_total = 0u32;
    for frame in frames.as_array().unwrap().iter() {
        let kind = frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy());
        let stream = frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
        match kind.as_deref() {
            Some("snapshot") => {
                values.insert(stream, frame.get("value").unwrap().clone());
            }
            Some("ops") => {
                let raw = frame.get("ops").unwrap();
                let t = Instant::now();
                let ops: Vec<_> = raw
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(op_from_json)
                    .collect::<Result<_, _>>()
                    .unwrap();
                decode += t.elapsed();
                let before = values.get(&stream).expect("ops before snapshot");
                let t = Instant::now();
                let after = apply_immutable(before, &ops).unwrap();
                apply += t.elapsed();
                values.insert(stream, after);
                ops_frames += 1;
                ops_total += ops.len() as u32;
            }
            _ => {}
        }
    }
    println!(
        "host-frames.json: {ops_frames} ops frames, {ops_total} ops — decode {decode:?}, apply {apply:?}",
    );

    // Synthetic: ~500-entry conversation view, then 400 streamed appends
    // onto the newest message's text — the streaming hot path.
    let mut entries = String::new();
    for i in 0..500 {
        if i > 0 {
            entries.push(',');
        }
        let kind = if i % 2 == 0 { "pi.user" } else { "pi.assistant" };
        entries.push_str(&format!(
            r#"{{"id":"e{i}","kind":"{kind}","model":[{{"role":"user","content":[{{"type":"text","text":"message {i} with some body text to make it less trivial"}}],"timestamp":{i}}}]}}"#
        ));
    }
    let doc = format!(r#"{{"entries":[{entries}],"docs":{{}}}}"#);
    let mut value = Json::parse(&doc).unwrap();
    let bytes = value.to_json().len();
    let ops_src = r#"[["a",["entries",499,"model",0,"content",0,"text"]," some streamed text"]]"#;
    let mut applied = 0u32;
    let t = Instant::now();
    for _ in 0..400 {
        let ops = ops_of(ops_src);
        match apply_immutable(&value, &ops) {
            Ok(next) => value = next,
            Err(error) => panic!("apply failed: {error}"),
        }
        applied += 1;
    }
    let elapsed = t.elapsed();
    println!(
        "synthetic: {applied} appends on a {bytes}-byte stream value — {elapsed:?} total, {:?}/op",
        elapsed / applied.max(1)
    );
}
