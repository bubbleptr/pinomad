// Facade tests: PinomadClient through the UniFFI-facing surface — events
// and calls are the typed Ffi* variants, and every command the platform
// executes comes back as a return value. The scripted plaintext host is a
// slimmed copy of the remote_durable suite's.
#![cfg(feature = "ffi")]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use pinomad_core::ffi::{
    CallResult, ClientError, ConnectionState, ConversationChanges, ConversationCheckout, FfiCall,
    FfiCommand, FfiEvent, MessageImage, ModelRef, NewConversationHome, PatchLineKind, PinomadClient,
    ReadyOutcome, StoredHost, SubmitMode, ThinkingLevel,
};
use pinomad_core::json::{Json, JsonObject};
use pinomad_core::remote_durable::RemoteDurableOptions;
use pinomad_core::transport::PlaintextTransport;
use pinomad_core::u16str::U16String;

fn obj(fields: &[(&str, Json)]) -> Json {
    let mut object = JsonObject::new();
    for (name, value) in fields {
        object.set(U16String::from_str(name), value.clone());
    }
    Json::Object(std::sync::Arc::new(object))
}

fn default_snapshots() -> HashMap<String, Json> {
    let mut snapshots = HashMap::new();
    snapshots.insert("conversations".to_string(), Json::array(vec![]));
    snapshots.insert(
        "index".to_string(),
        obj(&[("projects", Json::array(vec![])), ("conversations", Json::array(vec![]))]),
    );
    snapshots.insert("devices".to_string(), obj(&[("devices", Json::array(vec![]))]));
    snapshots.insert("tasks".to_string(), obj(&[("tasks", obj(&[]))]));
    snapshots.insert("mcp".to_string(), Json::Null);
    snapshots.insert("models".to_string(), Json::array(vec![]));
    snapshots.insert("auth".to_string(), obj(&[("logins", Json::array(vec![]))]));
    snapshots.insert("settings".to_string(), obj(&[]));
    snapshots.insert("agents".to_string(), obj(&[("roles", Json::array(vec![])), ("problems", Json::array(vec![]))]));
    snapshots
}

fn snapshot_for(stream: &str, snapshots: &HashMap<String, Json>) -> Json {
    if let Some(value) = snapshots.get(stream) {
        return value.clone();
    }
    if let Some(rest) = stream.strip_prefix("conversation:") {
        let id: f64 = rest.parse().unwrap_or(f64::NAN);
        return obj(&[
            ("conversation", obj(&[("id", Json::Number(id))])),
            ("entries", Json::array(vec![])),
        ]);
    }
    if stream.starts_with("doc:") {
        return obj(&[("requests", Json::array(vec![]))]);
    }
    Json::Null
}

/// Client frames in, server frames out — subscribes get a snapshot, calls
/// get an ok result (or the configured error). `minor` shapes the hello's
/// protocol minor so tests can pose as an older host.
struct ScriptedHost {
    snapshots: HashMap<String, Json>,
    held: HashSet<String>,
    call_errors: HashMap<String, String>,
    call_results: HashMap<String, Json>,
    minor: f64,
    sent: Vec<Json>,
    conn: u64,
}

impl ScriptedHost {
    fn new() -> Self {
        ScriptedHost {
            snapshots: default_snapshots(),
            held: HashSet::new(),
            call_errors: HashMap::new(),
            call_results: HashMap::new(),
            minor: 9.0,
            sent: Vec::new(),
            conn: 0,
        }
    }

    fn hello(&self) -> String {
        obj(&[
            ("type", Json::from("hello")),
            ("protocol", obj(&[("major", Json::from(5.0)), ("minor", Json::from(self.minor))])),
            ("session", obj(&[("id", Json::from("fake")), ("directory", Json::from(""))])),
            ("models", Json::array(vec![])),
            ("docs", Json::array(vec![])),
            ("toolPresentations", obj(&[])),
            ("defaults", obj(&[])),
        ])
        .to_json()
    }

    fn receive(&mut self, text: &str) -> Vec<String> {
        let frame = Json::parse(text).expect("client frame JSON");
        self.sent.push(frame.clone());
        match frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() {
            Some("subscribe") => {
                let stream = frame
                    .get("stream")
                    .and_then(Json::as_str)
                    .map(|s| s.to_string_lossy())
                    .unwrap_or_default();
                if self.held.contains(&stream) {
                    return vec![];
                }
                vec![obj(&[
                    ("type", Json::from("snapshot")),
                    ("stream", frame.get("stream").cloned().unwrap_or(Json::Null)),
                    ("value", snapshot_for(&stream, &self.snapshots)),
                ])
                .to_json()]
            }
            Some("call") => {
                let id = frame.get("id").cloned().unwrap_or(Json::Null);
                let method = frame
                    .get("method")
                    .and_then(Json::as_str)
                    .map(|s| s.to_string_lossy())
                    .unwrap_or_default();
                let result = if let Some(error) = self.call_errors.get(&method) {
                    obj(&[
                        ("type", Json::from("result")),
                        ("id", id),
                        ("ok", Json::Bool(false)),
                        ("error", Json::from(error.clone())),
                    ])
                } else {
                    obj(&[
                        ("type", Json::from("result")),
                        ("id", id),
                        ("ok", Json::Bool(true)),
                        (
                            "value",
                            self.call_results.get(&method).cloned().unwrap_or(Json::Null),
                        ),
                    ])
                };
                vec![result.to_json()]
            }
            _ => vec![],
        }
    }
}

/// The platform side: execute every command the facade returns, feeding
/// socket events back in until the loop settles.
struct Harness {
    client: Arc<PinomadClient>,
    host: ScriptedHost,
    ready: Option<ReadyOutcome>,
    ops: HashMap<u64, Result<CallResult, String>>,
    view_changes: u64,
    paired: bool,
}

impl Harness {
    fn new() -> Self {
        Self::new_with("req-1")
    }

    fn new_with(request_id: &'static str) -> Self {
        Self::boot(ScriptedHost::new(), request_id)
    }

    /// Connect with a preconfigured host — snapshots, held streams, call
    /// results, and protocol minor are set before the client opens.
    fn boot(host: ScriptedHost, request_id: &'static str) -> Self {
        let client = PinomadClient::with_options(RemoteDurableOptions {
            transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
            reconnect_delay_ms: Some((20, 20)),
            request_id: Some(Box::new(move || request_id.to_string())),
        });
        let mut harness = Harness {
            client: Arc::new(client),
            host,
            ready: None,
            ops: HashMap::new(),
            view_changes: 0,
            paired: false,
        };
        let initial = harness.client.take();
        harness.pump(initial);
        harness
    }

    fn handle(&mut self, event: FfiEvent) {
        let commands = self.client.handle(event);
        self.pump(commands);
    }

    fn pump(&mut self, commands: Vec<FfiCommand>) {
        let mut queue: VecDeque<FfiCommand> = commands.into();
        while let Some(command) = queue.pop_front() {
            match command {
                FfiCommand::OpenConnection { conn, .. } => {
                    self.host.conn = conn;
                    queue.extend(self.client.handle(FfiEvent::SocketOpened { conn }));
                    let hello = self.host.hello();
                    queue.extend(self.client.handle(FfiEvent::SocketData { conn, bytes: hello.into_bytes() }));
                }
                FfiCommand::SendBytes { conn, bytes } => {
                    let replies = self.host.receive(std::str::from_utf8(&bytes).expect("client frame"));
                    for reply in replies {
                        queue.extend(self.client.handle(FfiEvent::SocketData { conn, bytes: reply.into_bytes() }));
                    }
                }
                FfiCommand::CloseSocket { conn } => {
                    queue.extend(self.client.handle(FfiEvent::SocketClosed { conn, code: 1000, reason: None }));
                }
                FfiCommand::ScheduleReconnect { .. } | FfiCommand::CancelReconnect { .. } => {}
                FfiCommand::Ready { outcome } => self.ready = Some(outcome),
                FfiCommand::ViewChanged => self.view_changes += 1,
                FfiCommand::Paired { .. } => self.paired = true,
                FfiCommand::OperationSucceeded { op, value } => {
                    self.ops.insert(op, Ok(value));
                }
                FfiCommand::OperationFailed { op, error } => {
                    self.ops.insert(op, Err(error));
                }
            }
        }
    }

    fn invoke(&mut self, op: u64, call: FfiCall) {
        self.handle(FfiEvent::Invoke { op, call });
    }
}

#[test]
fn client_connects_and_reports_a_snapshot() {
    let h = Harness::new();
    assert_eq!(h.ready, Some(ReadyOutcome::Connected));
    let snapshot = h.client.snapshot().expect("snapshot after connected");
    assert_eq!(snapshot.connection, ConnectionState::Connected);
    assert_eq!(snapshot.version, h.view_changes);
}

#[test]
fn client_works_when_created_and_driven_on_another_thread() {
    let handle = std::thread::spawn(|| {
        let client = PinomadClient::with_options(RemoteDurableOptions {
            transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
            reconnect_delay_ms: None,
            request_id: None,
        });
        let mut h = Harness {
            client: Arc::new(client),
            host: ScriptedHost::new(),
            ready: None,
            ops: HashMap::new(),
            view_changes: 0,
            paired: false,
        };
        let initial = h.client.take();
        h.pump(initial);
        h.invoke(7, FfiCall::Compact { instructions: None });
        (h.ready, h.client.snapshot().is_some(), h.ops.contains_key(&7))
    });
    let (ready, has_snapshot, op_done) = handle.join().expect("client thread");
    assert_eq!(ready, Some(ReadyOutcome::Connected));
    assert!(has_snapshot);
    assert!(op_done);
}

#[test]
fn snapshot_version_counts_view_changes() {
    let mut h = Harness::new();
    let before = h.client.snapshot().unwrap().version;
    assert_eq!(before, h.view_changes);
    // A host notice dirties the view exactly once.
        let conn = h.host.conn;
    h.handle(FfiEvent::SocketData {
        conn,
        bytes: r#"{"type":"notice","level":"info","message":"hi"}"#.as_bytes().to_vec(),
    });
    let after = h.client.snapshot().unwrap().version;
    assert_eq!(after, before + 1);
    assert_eq!(after, h.view_changes);
    // The notice is in the snapshot with a stable id.
    let notices = &h.client.snapshot().unwrap().notices;
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].message, "hi");
    assert!(notices[0].id >= 1);
}

#[test]
fn a_failed_command_call_reports_success_and_a_notice() {
    let mut h = Harness::new();
    h.host.call_errors.insert("submit".to_string(), "the host refused".to_string());
    h.invoke(
        3,
        FfiCall::Submit {
            text: "hi".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: None,
            request_id: None,
            images: vec![],
        },
    );
    // Command-class failures still succeed — no conversation is shown, so
    // this failed in `op_steps` even before the wire ("No conversation
    // selected").
    assert_eq!(h.ops.get(&3), Some(&Ok(CallResult::Unit)));
    let notices = &h.client.snapshot().unwrap().notices;
    assert!(notices.iter().any(|n| n.message.contains("No conversation selected") || n.message.contains("the host refused")));
}

#[test]
fn a_failed_request_call_reports_operation_failed() {
    let mut h = Harness::new();
    h.host.call_errors.insert("listFolders".to_string(), "no such dir".to_string());
    h.invoke(9, FfiCall::ListFolders { path: Some("/nope".to_string()) });
    assert_eq!(h.ops.get(&9), Some(&Err("no such dir".to_string())));
}

fn call_frames(h: &Harness) -> Vec<Json> {
    h.host
        .sent
        .iter()
        .filter(|frame| frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy() == "call").unwrap_or(false))
        .cloned()
        .collect()
}

/// The vectors the TS side generated — FfiCall must emit the same wire.
#[test]
fn ffi_calls_encode_the_same_frames_as_the_reference() {
    let vectors = Json::parse(
        &std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/protocol/test/fixtures/rust-vectors/frames.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let wires: HashMap<String, Json> = vectors
        .get("clientFrames")
        .and_then(Json::as_array)
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry.get("name").unwrap().as_str().unwrap().to_string_lossy(),
                Json::parse(&entry.get("wire").unwrap().as_str().unwrap().to_string_lossy()).unwrap(),
            )
        })
        .collect();

    let mut h = Harness::new_with("r");
    h.invoke(
        1,
        FfiCall::Submit {
            text: "中文 ✓ 🚀".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: Some(2),
            request_id: Some("req-1".to_string()),
            images: vec![MessageImage {
                data: "AA==".to_string(),
                mime_type: "image/png".to_string(),
            }],
        },
    );
    h.invoke(
        2,
        FfiCall::CreateConversation {
            home: NewConversationHome::Project { path: "/home/u/app".to_string() },
            text: "go".to_string(),
            checkout: Some(ConversationCheckout::Worktree),
            model: Some(ModelRef {
                provider: "p".to_string(),
                model_id: "m".to_string(),
            }),
            thinking_level: Some(ThinkingLevel::High),
            images: vec![],
        },
    );
    h.invoke(3, FfiCall::SetPushToken { token: None });

    let calls = call_frames(&h);
    let by_method: HashMap<String, &Json> = calls
        .iter()
        .map(|frame| {
            (
                frame.get("method").unwrap().as_str().unwrap().to_string_lossy(),
                frame,
            )
        })
        .collect();
    for (vector_name, method) in [
        ("call-submit", "submit"),
        ("call-createConversation", "createConversation"),
        ("call-null-arg", "setPushToken"),
    ] {
        let expected = wires[vector_name].clone();
        let actual = by_method[method].clone();
        // The call counter assigns ids — everything else must be identical.
        for field in ["type", "method", "args"] {
            assert_eq!(
                actual.get(field).cloned(),
                expected.get(field).cloned(),
                "{vector_name} differs on {field}: {} vs {}",
                actual.to_json(),
                expected.to_json()
            );
        }
    }
}

#[test]
fn validate_stored_host_accepts_good_and_drops_bad_account() {
    use pinomad_core::ffi::{validate_stored_host, StoredHostAccount, StoredHostError};
    let good = StoredHost {
        url: "wss://host.example/".to_string(),
        host_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        private_key: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_string(),
        account: Some(StoredHostAccount {
            server_origin: "https://relay.example".to_string(),
            // Not base64url of 32 bytes → the link drops, the host stays.
            host_id: "bad".to_string(),
        }),
    };
    let validated = validate_stored_host(good).expect("valid host");
    assert!(validated.account.is_none(), "malformed link drops only the account");

    let bad_url = StoredHost {
        url: "https://not-a-socket/".to_string(),
        ..validated.clone()
    };
    assert_eq!(validate_stored_host(bad_url), Err(StoredHostError::InvalidUrl));
}

const CHANGES_PATCH: &str = "diff --git a/t.txt b/t.txt\nindex 1111111..2222222 100644\n--- a/t.txt\n+++ b/t.txt\n@@ -1 +1 @@\n-old\n+new\n";

/// The `changes` call's wire args — the shown conversation by default, the
/// given `conversation_id` otherwise.
#[test]
fn changes_call_targets_a_conversation() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "changes".to_string(),
        obj(&[
            ("available", Json::Bool(true)),
            ("base", Json::from("c0ffee")),
            ("patch", Json::from(CHANGES_PATCH)),
            ("truncated", Json::Bool(false)),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::Changes { conversation_id: Some(7) });
    // No conversation shown and none given → the request fails before the wire.
    h.invoke(2, FfiCall::Changes { conversation_id: None });
    h.invoke(3, FfiCall::SwitchConversation { id: 4 });
    h.invoke(4, FfiCall::Changes { conversation_id: None });

    let calls = call_frames(&h);
    let changes: Vec<&Json> = calls
        .iter()
        .filter(|f| f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "changes").unwrap_or(false))
        .collect();
    assert_eq!(changes.len(), 2);
    assert_eq!(
        changes[0].get("args").and_then(|a| a.get("conversationId")).cloned(),
        Some(Json::Number(7.0))
    );
    // None fell back to the shown conversation (4).
    assert_eq!(
        changes[1].get("args").and_then(|a| a.get("conversationId")).cloned(),
        Some(Json::Number(4.0))
    );
    assert!(matches!(h.ops.get(&2), Some(Err(error)) if error.contains("No conversation selected")));
}

#[test]
fn changes_result_decodes_available_into_parsed_files() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "changes".to_string(),
        obj(&[
            ("available", Json::Bool(true)),
            ("base", Json::from("c0ffee")),
            ("patch", Json::from(CHANGES_PATCH)),
            ("truncated", Json::Bool(true)),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::Changes { conversation_id: Some(7) });
    let Some(Ok(CallResult::Changes { changes })) = h.ops.get(&1) else {
        panic!("op 1 resolved: {:?}", h.ops.get(&1))
    };
    let ConversationChanges::Available { base, files, truncated } = changes else {
        panic!("available result: {changes:?}")
    };
    assert_eq!(base, "c0ffee");
    assert_eq!(*truncated, true);
    assert_eq!(files.len(), 1);
    let file = &files[0];
    assert_eq!(file.path, "t.txt");
    assert_eq!(file.old_path.as_deref(), Some("t.txt"));
    assert_eq!((file.additions, file.deletions), (1, 1));
    assert_eq!(file.lines.len(), 3);
    assert_eq!(file.lines[0].kind, PatchLineKind::Meta);
    assert_eq!(file.lines[1].kind, PatchLineKind::Del);
    assert_eq!(file.lines[1].text, "-old");
    assert_eq!(file.lines[2].kind, PatchLineKind::Add);
}

#[test]
fn changes_result_decodes_unavailable() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "changes".to_string(),
        obj(&[("available", Json::Bool(false)), ("reason", Json::from("Not in a git repository"))]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::Changes { conversation_id: Some(7) });
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Changes {
            changes: ConversationChanges::Unavailable {
                reason: "Not in a git repository".to_string(),
            },
        }))
    );
}

#[test]
fn changes_result_malformed_fails_the_op() {
    for (index, value) in [
        obj(&[]),                                             // no `available`
        obj(&[("available", Json::Number(1.0))]),             // wrong type
        obj(&[("available", Json::Bool(true))]),              // missing patch/base
        Json::Null,                                           // not an object
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("changes".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::Changes { conversation_id: Some(7) });
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed changes result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
}

#[test]
fn snapshot_agents_is_none_before_the_stream() {
    // A pre-5.6 host never subscribes `agents` — the view's `null` decodes
    // to None rather than an empty record.
    let mut host = ScriptedHost::new();
    host.minor = 5.0;
    let h = Harness::boot(host, "req-1");
    assert_eq!(h.ready, Some(ReadyOutcome::Connected));
    assert_eq!(h.client.snapshot().unwrap().agents, None);
}

#[test]
fn snapshot_agents_decodes_roles_and_problems() {
    let mut host = ScriptedHost::new();
    host.snapshots.insert(
        "agents".to_string(),
        obj(&[
            (
                "roles",
                Json::array(vec![obj(&[
                    ("name", Json::from("reviewer")),
                    ("description", Json::from("Reviews code")),
                    ("model", Json::from("anthropic/claude-x")),
                    ("thinkingLevel", Json::from("high")),
                    ("prompt", Json::from("Be strict.")),
                ])]),
            ),
            (
                "problems",
                Json::array(vec![obj(&[
                    ("file", Json::from("Broken.md")),
                    ("reason", Json::from("bad frontmatter")),
                ])]),
            ),
        ]),
    );
    let h = Harness::boot(host, "req-1");
    let agents = h.client.snapshot().unwrap().agents.expect("agents arrived");
    assert_eq!(agents.roles.len(), 1);
    let role = &agents.roles[0];
    assert_eq!(role.name, "reviewer");
    assert_eq!(role.description, "Reviews code");
    assert_eq!(role.model.as_deref(), Some("anthropic/claude-x"));
    assert_eq!(role.thinking_level, Some(ThinkingLevel::High));
    assert_eq!(role.prompt, "Be strict.");
    assert_eq!(agents.problems.len(), 1);
    assert_eq!(agents.problems[0].file, "Broken.md");
    assert_eq!(agents.problems[0].reason, "bad frontmatter");
}

#[test]
fn connect_rejects_bad_key_material() {
    let result = PinomadClient::connect(StoredHost {
        url: "wss://host.example/".to_string(),
        host_key: "not base64url!!".to_string(),
        private_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        account: None,
    });
    assert!(matches!(result, Err(ClientError::KeyMaterial { .. })));
}
