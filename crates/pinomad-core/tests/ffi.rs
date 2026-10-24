// Facade tests: PinomadClient through the UniFFI-facing surface — events
// and calls are the typed Ffi* variants, and every command the platform
// executes comes back as a return value. The scripted plaintext host is a
// slimmed copy of the remote_durable suite's.
#![cfg(feature = "ffi")]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use pinomad_core::ffi::{
    device_public_key, parse_command_input, CallResult, ClientError, CommandEntry, CommandInput, CommandSource, ConnectionState, ConversationChanges, ConversationCheckout,
    DeviceEntry, DeviceSource, FetchedImage, FfiCall, FfiCommand, FfiEvent, FileScope, HostSettingsState, ImageVariant, MessageImage, ModelRef,
    NewConversationHome, PatchLineKind, PinomadClient, ReadyOutcome, SkillEntry, SkillScope, SkillSource,
    SteerOutcome, StoredHost, SubmitMode, ThinkingLevel, WithdrawOutcome,
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
            minor: pinomad_core::frames::PROTOCOL.minor as f64,
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
            skills: None,
            attachments: vec![],
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
                ref_: None,
            }],
            skills: None,
            attachments: vec![],
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
            agent: None,
            images: vec![],
            skills: None,
            attachments: vec![],
        },
    );
    h.invoke(3, FfiCall::SetPushToken { token: None });
    // 5.10 additions: the agent field and the listFiles call.
    h.invoke(
        4,
        FfiCall::CreateConversation {
            home: NewConversationHome::Chat,
            text: "go".to_string(),
            checkout: None,
            model: None,
            thinking_level: None,
            agent: Some("reviewer".to_string()),
            images: vec![],
            skills: None,
            attachments: vec![],
        },
    );
    h.invoke(
        5,
        FfiCall::ListFiles {
            scope: FileScope::Project { path: "/home/u/app".to_string(), checkout: ConversationCheckout::Worktree },
            query: "".to_string(),
        },
    );
    h.invoke(
        6,
        FfiCall::ListFiles {
            scope: FileScope::Conversation { conversation_id: 7 },
            query: "src/".to_string(),
        },
    );
    h.invoke(7, FfiCall::WithdrawQueued { submission_id: 3, target: Some(2) });
    h.invoke(8, FfiCall::SteerQueued { submission_id: 3, target: Some(2) });
    // 5.18 additions: switching the shown conversation's agent, name and null.
    h.invoke(9, FfiCall::SwitchConversation { id: 2 });
    h.invoke(10, FfiCall::SetAgent { agent: Some("reviewer".to_string()) });
    h.invoke(11, FfiCall::SetAgent { agent: None });
    // 5.19 additions: host-stored attachment uploads and message refs.
    h.invoke(12, FfiCall::BeginAttachment { name: "notes.txt".to_string(), size: 5 });
    h.invoke(
        13,
        FfiCall::AppendAttachment {
            attachment_id: "A".repeat(22),
            offset: 0,
            data: "aGVsbG8=".to_string(),
        },
    );
    h.invoke(
        14,
        FfiCall::Submit {
            text: "look".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: Some(2),
            request_id: Some("r".to_string()),
            images: vec![],
            skills: None,
            attachments: vec!["A".repeat(22)],
        },
    );

    let calls = call_frames(&h);
    let by_name: HashMap<String, Vec<&Json>> = calls.iter().fold(HashMap::new(), |mut acc, frame| {
        acc.entry(frame.get("method").unwrap().as_str().unwrap().to_string_lossy())
            .or_default()
            .push(frame);
        acc
    });
    let pairs: Vec<(&str, &Json)> = [
        ("call-submit", by_name["submit"][0]),
        ("call-createConversation", by_name["createConversation"][0]),
        ("call-null-arg", by_name["setPushToken"][0]),
        ("call-createConversation-agent", by_name["createConversation"][1]),
        ("call-listFiles-project", by_name["listFiles"][0]),
        ("call-listFiles-conversation", by_name["listFiles"][1]),
        ("call-withdrawQueued", by_name["withdrawQueued"][0]),
        ("call-steerQueued", by_name["steerQueued"][0]),
        ("call-setAgent", by_name["setAgent"][0]),
        ("call-setAgent-null", by_name["setAgent"][1]),
        ("call-beginAttachment", by_name["beginAttachment"][0]),
        ("call-appendAttachment", by_name["appendAttachment"][0]),
        ("call-submit-attachments", by_name["submit"][1]),
    ]
    .into_iter()
    .collect();
    for (vector_name, actual) in pairs {
        let expected = wires[vector_name].clone();
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
fn ffi_sends_image_refs_and_keeps_bytes_inline() {
    let mut h = Harness::new();
    h.invoke(1, FfiCall::SwitchConversation { id: 1 });
    h.invoke(
        2,
        FfiCall::Submit {
            text: "look".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: None,
            request_id: None,
            images: vec![
                MessageImage {
                    data: "aGk=".to_string(),
                    mime_type: "image/png".to_string(),
                    ref_: None,
                },
                MessageImage {
                    data: String::new(),
                    mime_type: "image/jpeg".to_string(),
                    ref_: Some("abc123".to_string()),
                },
                // Data wins when both forms are present.
                MessageImage {
                    data: "AA==".to_string(),
                    mime_type: "image/png".to_string(),
                    ref_: Some("ignored".to_string()),
                },
            ],
            skills: None,
            attachments: vec![],
        },
    );
    let frames = call_frames(&h);
    assert_eq!(
        frames[0].get("args").and_then(|args| args.get("images")).cloned(),
        Some(Json::array(vec![
            obj(&[("data", Json::from("aGk=")), ("mimeType", Json::from("image/png"))]),
            obj(&[("ref", Json::from("abc123"))]),
            obj(&[("data", Json::from("AA==")), ("mimeType", Json::from("image/png"))]),
        ]))
    );
}

#[test]
fn queued_call_results_are_typed_and_queued_input_reads_on_demand() {
    let mut h = Harness::new();
    h.host.call_results.insert("withdrawQueued".to_string(), obj(&[("outcome", Json::from("sent"))]));
    h.host.call_results.insert("steerQueued".to_string(), obj(&[("outcome", Json::from("steered"))]));
    h.invoke(1, FfiCall::WithdrawQueued { submission_id: 3, target: Some(2) });
    h.invoke(2, FfiCall::SteerQueued { submission_id: 3, target: Some(2) });
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::WithdrawQueued { outcome: WithdrawOutcome::Sent }))
    );
    assert_eq!(
        h.ops.get(&2),
        Some(&Ok(CallResult::SteerQueued { outcome: SteerOutcome::Steered }))
    );

    h.host.call_results.insert("steerQueued".to_string(), obj(&[("outcome", Json::from("nope"))]));
    h.invoke(3, FfiCall::SteerQueued { submission_id: 3, target: Some(2) });
    assert!(matches!(h.ops.get(&3), Some(Err(error)) if error.contains("malformed steerQueued")));

    let inbox = obj(&[
        ("id", Json::Number(7.0)),
        ("mode", Json::from("followUp")),
        ("content", Json::array(vec![
            obj(&[("type", Json::from("text")), ("text", Json::from("hello"))]),
            obj(&[
                ("type", Json::from("image")),
                ("data", Json::from("aGk=")),
                ("mimeType", Json::from("image/png")),
            ]),
        ])),
    ]);
    let write = obj(&[
        ("id", Json::Number(2.0)),
        ("mode", Json::from("write")),
        ("entry", obj(&[("kind", Json::from("pi.note"))])),
    ]);
    let conversation = obj(&[
        ("conversation", obj(&[("id", Json::Number(1.0))])),
        ("entries", Json::array(vec![])),
        (
            "docs",
            obj(&[("pi.inbox", obj(&[("items", Json::array(vec![inbox, write]))]))]),
        ),
    ]);
    h.host.snapshots.insert("conversation:1".to_string(), conversation);
    h.invoke(4, FfiCall::SwitchConversation { id: 1 });
    let conversation = h.client.snapshot().unwrap().conversation.expect("conversation");
    assert!(conversation.fresh);
    assert!(conversation.fresh_epoch > 0);
    let input = h.client.queued_input(7).expect("queued input");
    assert_eq!(input.text, "hello");
    assert_eq!(
        input.images,
        vec![MessageImage {
            data: "aGk=".to_string(),
            mime_type: "image/png".to_string(),
            ref_: None,
        }]
    );
    assert!(h.client.queued_input(2).is_none());
    assert!(h.client.queued_input(99).is_none());
}
#[test]
fn validate_stored_host_accepts_good_and_drops_bad_account() {
    use pinomad_core::ffi::{validate_stored_host, StoredHostAccount, StoredHostError};
    let good = StoredHost {
        url: "wss://host.example/".to_string(),
        host_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        private_key: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_string(),
        name: None,
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
            ("branch", Json::from("main")),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::Changes { conversation_id: Some(7) });
    let Some(Ok(CallResult::Changes { changes })) = h.ops.get(&1) else {
        panic!("op 1 resolved: {:?}", h.ops.get(&1))
    };
    let ConversationChanges::Available {
        base,
        files,
        truncated,
        branch,
    } = changes
    else {
        panic!("available result: {changes:?}")
    };
    assert_eq!(base, "c0ffee");
    assert_eq!(*truncated, true);
    assert_eq!(branch.as_deref(), Some("main"));
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
                branch: None,
            },
        }))
    );
}

/// 5.11: HEAD's branch rides the `unavailable` shape too (an unborn branch
/// has no diff), and fields added later decode along untouched.
#[test]
fn changes_result_carries_the_branch() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "changes".to_string(),
        obj(&[
            ("available", Json::Bool(false)),
            ("reason", Json::from("Not in a git repository")),
            ("branch", Json::from("main")),
            ("future", Json::from("anything")),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::Changes { conversation_id: Some(7) });
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Changes {
            changes: ConversationChanges::Unavailable {
                reason: "Not in a git repository".to_string(),
                branch: Some("main".to_string()),
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
        obj(&[
            // `branch` is optional but must be a string when present.
            ("available", Json::Bool(false)),
            ("reason", Json::from("nope")),
            ("branch", Json::Number(1.0)),
        ]),
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

/// `listFiles`: a Request-class call sent outside the command queue —
/// its success decodes to `CallResult::Files`, a malformed result or a
/// host error fails the op, and a pre-5.10 host is refused locally.
#[test]
fn list_files_resolves_a_typed_result() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "listFiles".to_string(),
        obj(&[
            ("files", Json::array(vec![Json::from("src/a.ts"), Json::from("b/c.txt")])),
            ("truncated", Json::Bool(true)),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(
        1,
        FfiCall::ListFiles {
            scope: FileScope::Conversation { conversation_id: 7 },
            query: "src".to_string(),
        },
    );
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Files {
            files: vec!["src/a.ts".to_string(), "b/c.txt".to_string()],
            truncated: true,
        }))
    );
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "listFiles").unwrap_or(false)
    });
    assert_eq!(
        call.and_then(|f| f.get("args").cloned()),
        Some(obj(&[
            ("scope", obj(&[("kind", Json::from("conversation")), ("conversationId", Json::from(7.0))])),
            ("query", Json::from("src")),
        ]))
    );
}

/// `image` (5.15, ADR-0027): unqueued like `listFiles`, decodes to the
/// typed bytes. A malformed result fails the op, and a pre-5.15 host is
/// refused locally instead of 4400ing the socket.
#[test]
fn image_resolves_bytes_and_is_gated_on_5_15() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "image".to_string(),
        obj(&[
            ("data", Json::from("AA==")),
            ("mimeType", Json::from("image/png")),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::Image { ref_: "abc123".to_string(), variant: None });
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Image {
            image: FetchedImage {
                data: "AA==".to_string(),
                mime_type: "image/png".to_string(),
                variant: ImageVariant::Original,
            },
        })),
    );
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "image").unwrap_or(false)
    });
    assert_eq!(
        call.and_then(|f| f.get("args").cloned()),
        Some(obj(&[("ref", Json::from("abc123"))])),
    );

    let mut bad = ScriptedHost::new();
    bad.call_results.insert("image".to_string(), obj(&[("data", Json::from("AA=="))]));
    let mut h = Harness::boot(bad, "req-1");
    h.invoke(1, FfiCall::Image { ref_: "abc123".to_string(), variant: None });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("malformed image result")));

    let mut old = ScriptedHost::new();
    old.minor = 14.0;
    let mut h = Harness::boot(old, "req-1");
    h.invoke(1, FfiCall::Image { ref_: "abc123".to_string(), variant: None });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.15")));
    assert!(call_frames(&h).iter().all(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy()) != Some("image".to_string())
    }));
}

#[test]
fn image_returns_the_actual_variant_from_the_host() {
    for (requested, request_wire, returned, expected) in [
        (
            ImageVariant::Thumbnail,
            "thumbnail",
            "thumbnail",
            ImageVariant::Thumbnail,
        ),
        (
            ImageVariant::Preview,
            "preview",
            "preview",
            ImageVariant::Preview,
        ),
        (
            ImageVariant::Thumbnail,
            "thumbnail",
            "original",
            ImageVariant::Original,
        ),
    ] {
        let mut host = ScriptedHost::new();
        host.minor = 20.0;
        host.call_results.insert(
            "image".to_string(),
            obj(&[
                ("data", Json::from("AA==")),
                ("mimeType", Json::from("image/png")),
                ("variant", Json::from(returned)),
            ]),
        );
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::Image { ref_: "abc123".to_string(), variant: Some(requested) });
        assert_eq!(
            h.ops.get(&1),
            Some(&Ok(CallResult::Image {
                image: FetchedImage {
                    data: "AA==".to_string(),
                    mime_type: "image/png".to_string(),
                    variant: expected,
                },
            })),
        );
        let call = call_frames(&h).into_iter().find(|f| {
            f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "image").unwrap_or(false)
        });
        assert_eq!(
            call.and_then(|f| f.get("args").cloned()),
            Some(obj(&[("ref", Json::from("abc123")), ("variant", Json::from(request_wire))])),
        );
    }
}

#[test]
fn image_derived_request_on_an_old_host_returns_original() {
    let mut host = ScriptedHost::new();
    host.minor = 19.0;
    host.call_results.insert(
        "image".to_string(),
        obj(&[("data", Json::from("AA==")), ("mimeType", Json::from("image/png"))]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(
        1,
        FfiCall::Image {
            ref_: "abc123".to_string(),
            variant: Some(ImageVariant::Preview),
        },
    );
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Image {
            image: FetchedImage {
                data: "AA==".to_string(),
                mime_type: "image/png".to_string(),
                variant: ImageVariant::Original,
            },
        })),
    );
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "image").unwrap_or(false)
    });
    assert_eq!(
        call.and_then(|f| f.get("args").cloned()),
        Some(obj(&[("ref", Json::from("abc123"))])),
    );
}

#[test]
fn list_files_result_malformed_or_error_fails_the_op() {
    for (index, value) in [
        obj(&[("files", Json::array(vec![]))]),                          // missing truncated
        obj(&[("files", Json::array(vec![Json::from(1.0)])), ("truncated", Json::Bool(false))]), // bad entry
        Json::Null,                                                      // not an object
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("listFiles".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(
            1,
            FfiCall::ListFiles { scope: FileScope::Conversation { conversation_id: 1 }, query: "".to_string() },
        );
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed listFiles result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
    // A host-side `ok:false` is an OperationFailed too.
    let mut host = ScriptedHost::new();
    host.call_errors.insert("listFiles".to_string(), "Conversation 9 does not exist".to_string());
    let mut h = Harness::boot(host, "req-1");
    h.invoke(
        1,
        FfiCall::ListFiles { scope: FileScope::Conversation { conversation_id: 9 }, query: "".to_string() },
    );
    assert_eq!(h.ops.get(&1), Some(&Err("Conversation 9 does not exist".to_string())));
}

/// `listSkills` (issue #143): same unqueued Request-class shape as
/// `listFiles` — the success value decodes to `CallResult::Skills`, malformed
/// results and host errors fail the op, a pre-5.13 host is refused locally.
#[test]
fn list_skills_resolves_a_typed_result() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "listSkills".to_string(),
        obj(&[(
            "skills",
            Json::array(vec![
                obj(&[
                    ("name", Json::from("review")),
                    ("description", Json::from("Reviews code")),
                    ("source", Json::from("project")),
                ]),
                obj(&[
                    ("name", Json::from("deploy")),
                    ("description", Json::from("Deploys")),
                    ("source", Json::from("user")),
                ]),
            ]),
        )]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(
        1,
        FfiCall::ListSkills {
            scope: SkillScope::Project {
                path: "/p".to_string(),
                checkout: ConversationCheckout::Worktree,
            },
        },
    );
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Skills {
            skills: vec![
                SkillEntry { name: "review".to_string(), description: "Reviews code".to_string(), source: SkillSource::Project },
                SkillEntry { name: "deploy".to_string(), description: "Deploys".to_string(), source: SkillSource::User },
            ],
        }))
    );
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "listSkills").unwrap_or(false)
    });
    assert_eq!(
        call.and_then(|f| f.get("args").cloned()),
        Some(obj(&[(
            "scope",
            obj(&[("kind", Json::from("project")), ("path", Json::from("/p")), ("checkout", Json::from("worktree"))]),
        )]))
    );
}

#[test]
fn list_skills_result_malformed_or_error_fails_the_op() {
    for (index, value) in [
        obj(&[]),                                                                // missing skills
        obj(&[("skills", Json::array(vec![Json::from("review")]))]),             // entry not an object
        obj(&[("skills", Json::array(vec![obj(&[("name", Json::from("x")), ("description", Json::from("y")), ("source", Json::from("other"))])]))]), // unknown source
        Json::Null,                                                              // not an object
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("listSkills".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::ListSkills { scope: SkillScope::Chat });
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed listSkills result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
    // A host-side `ok:false` is an OperationFailed too.
    let mut host = ScriptedHost::new();
    host.call_errors.insert("listSkills".to_string(), "Conversation 9 does not exist".to_string());
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::ListSkills { scope: SkillScope::Conversation { conversation_id: 9 } });
    assert_eq!(h.ops.get(&1), Some(&Err("Conversation 9 does not exist".to_string())));
}

#[test]
fn list_skills_needs_a_5_13_host() {
    let mut host = ScriptedHost::new();
    host.minor = 12.0;
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::ListSkills { scope: SkillScope::Chat });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.13")));
    assert!(call_frames(&h).iter().all(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() != "listSkills").unwrap_or(true)
    }));
}

/// `listCommands` (ADR-0029): a Request-class call sent outside the queue
/// whose success decodes to `CallResult::Commands`, optional fields included.
#[test]
fn list_commands_resolves_a_typed_result() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "listCommands".to_string(),
        obj(&[(
            "commands",
            Json::array(vec![
                obj(&[
                    ("name", Json::from("compact")),
                    ("description", Json::from("Summarize older context")),
                    ("argumentHint", Json::from("[instructions]")),
                    ("source", Json::from("builtin")),
                ]),
                obj(&[
                    ("name", Json::from("deploy")),
                    ("description", Json::from("Deploys")),
                    ("source", Json::from("plugin")),
                    ("disabled", Json::from("Busy")),
                ]),
            ]),
        )]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::ListCommands { conversation_id: 7 });
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Commands {
            commands: vec![
                CommandEntry {
                    name: "compact".to_string(),
                    description: "Summarize older context".to_string(),
                    argument_hint: Some("[instructions]".to_string()),
                    source: CommandSource::Builtin,
                    disabled: None,
                },
                CommandEntry {
                    name: "deploy".to_string(),
                    description: "Deploys".to_string(),
                    argument_hint: None,
                    source: CommandSource::Plugin,
                    disabled: Some("Busy".to_string()),
                },
            ],
        }))
    );
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "listCommands").unwrap_or(false)
    });
    assert_eq!(call.and_then(|f| f.get("args").cloned()), Some(obj(&[("conversationId", Json::from(7.0))])));
}

#[test]
fn list_commands_result_malformed_or_error_fails_the_op() {
    let entry = |extra: (&str, Json)| {
        obj(&[
            ("name", Json::from("x")),
            ("description", Json::from("y")),
            ("source", Json::from("builtin")),
            extra,
        ])
    };
    for (index, value) in [
        obj(&[]),                                                                   // missing commands
        obj(&[("commands", Json::array(vec![Json::from("compact")]))]),             // entry not an object
        obj(&[("commands", Json::array(vec![entry(("source", Json::from("other")))]))]), // unknown source
        obj(&[("commands", Json::array(vec![entry(("argumentHint", Json::from(3.0)))]))]), // non-string hint
        obj(&[("commands", Json::array(vec![entry(("disabled", Json::Bool(true)))]))]), // non-string reason
        Json::Null,                                                                 // not an object
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("listCommands".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::ListCommands { conversation_id: 7 });
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed listCommands result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
    let mut host = ScriptedHost::new();
    host.call_errors.insert("listCommands".to_string(), "Conversation 9 does not exist".to_string());
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::ListCommands { conversation_id: 9 });
    assert_eq!(h.ops.get(&1), Some(&Err("Conversation 9 does not exist".to_string())));
}

#[test]
fn list_commands_needs_a_5_17_host() {
    let mut host = ScriptedHost::new();
    host.minor = 16.0;
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::ListCommands { conversation_id: 7 });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.17")));
    assert!(call_frames(&h).iter().all(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() != "listCommands").unwrap_or(true)
    }));
}

/// `runCommand` is Command-class: the frame carries the name and the
/// trimmed args, and the op resolves `Unit`.
#[test]
fn run_command_sends_name_and_args() {
    let mut h = Harness::boot(ScriptedHost::new(), "req-1");
    h.invoke(
        1,
        FfiCall::RunCommand { name: "compact".to_string(), args: Some("keep API notes".to_string()), target: Some(3) },
    );
    assert_eq!(h.ops.get(&1), Some(&Ok(CallResult::Unit)));
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "runCommand").unwrap_or(false)
    });
    assert_eq!(
        call.and_then(|f| f.get("args").cloned()),
        Some(obj(&[
            ("conversationId", Json::from(3.0)),
            ("name", Json::from("compact")),
            ("args", Json::from("keep API notes")),
        ]))
    );
}

#[test]
fn parse_command_input_splits_a_listed_command() {
    let names = vec!["compact".to_string()];
    assert_eq!(
        parse_command_input("/compact  keep API notes ".to_string(), names.clone()),
        Some(CommandInput { name: "compact".to_string(), args: Some("keep API notes".to_string()) })
    );
    assert_eq!(
        parse_command_input("/compact".to_string(), names.clone()),
        Some(CommandInput { name: "compact".to_string(), args: None })
    );
    assert_eq!(parse_command_input("/usr/bin/x".to_string(), names.clone()), None);
    assert_eq!(parse_command_input(" /compact".to_string(), names), None);
}

#[test]
fn begin_and_append_attachment_resolve_typed_results() {
    let id = "A".repeat(22);
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "beginAttachment".to_string(),
        obj(&[("attachmentId", Json::from(id.clone()))]),
    );
    host.call_results.insert(
        "appendAttachment".to_string(),
        obj(&[("received", Json::from(5.0)), ("complete", Json::Bool(true))]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::BeginAttachment { name: "notes.txt".to_string(), size: 5 });
    h.invoke(2, FfiCall::AppendAttachment {
        attachment_id: id.clone(),
        offset: 0,
        data: "aGVsbG8=".to_string(),
    });
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::BeginAttachment { attachment_id: id.clone() }))
    );
    assert_eq!(
        h.ops.get(&2),
        Some(&Ok(CallResult::AppendAttachment { received: 5, complete: true }))
    );
    let frames = call_frames(&h);
    assert_eq!(
        frames[0].get("args").cloned(),
        Some(obj(&[("name", Json::from("notes.txt")), ("size", Json::from(5.0))]))
    );
    assert_eq!(
        frames[1].get("args").cloned(),
        Some(obj(&[
            ("attachmentId", Json::from(id)),
            ("offset", Json::from(0.0)),
            ("data", Json::from("aGVsbG8=")),
        ]))
    );
}

#[test]
fn attachment_results_malformed_or_error_fail_the_op() {
    for (index, value) in [
        obj(&[]),
        obj(&[("attachmentId", Json::from(""))]),
        obj(&[("attachmentId", Json::from(3.0))]),
        Json::Null,
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("beginAttachment".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::BeginAttachment { name: "notes.txt".to_string(), size: 5 });
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed beginAttachment result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
    for (index, value) in [
        obj(&[]),
        obj(&[("received", Json::from(-1.0)), ("complete", Json::Bool(true))]),
        obj(&[("received", Json::from(1.5)), ("complete", Json::Bool(true))]),
        obj(&[("received", Json::from(5.0)), ("complete", Json::from("yes"))]),
        Json::Null,
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("appendAttachment".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::AppendAttachment {
            attachment_id: "A".repeat(22),
            offset: 0,
            data: "aGVsbG8=".to_string(),
        });
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed appendAttachment result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
    // A host-side ok:false is an OperationFailed too.
    let mut host = ScriptedHost::new();
    host.call_errors.insert("beginAttachment".to_string(), "attachment budget exceeded".to_string());
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::BeginAttachment { name: "notes.txt".to_string(), size: 5 });
    assert_eq!(h.ops.get(&1), Some(&Err("attachment budget exceeded".to_string())));
}

#[test]
fn begin_and_append_attachment_need_a_5_19_host() {
    let mut host = ScriptedHost::new();
    host.minor = 18.0;
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::BeginAttachment { name: "notes.txt".to_string(), size: 5 });
    h.invoke(2, FfiCall::AppendAttachment {
        attachment_id: "A".repeat(22),
        offset: 0,
        data: "aGVsbG8=".to_string(),
    });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.19")));
    assert!(matches!(h.ops.get(&2), Some(Err(e)) if e.contains("needs protocol 5.19")));
    assert!(call_frames(&h).iter().all(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() != "beginAttachment" && s.to_string_lossy() != "appendAttachment").unwrap_or(true)
    }));
}

#[test]
fn submit_and_create_carry_attachments_and_refuse_them_before_5_19() {
    let id = "A".repeat(22);
    let mut h = Harness::new();
    h.invoke(
        1,
        FfiCall::Submit {
            text: "look".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: Some(2),
            request_id: Some("r".to_string()),
            images: vec![],
            skills: None,
            attachments: vec![id.clone()],
        },
    );
    h.invoke(
        2,
        FfiCall::CreateConversation {
            home: NewConversationHome::Chat,
            text: "go".to_string(),
            checkout: None,
            model: None,
            thinking_level: None,
            agent: None,
            images: vec![],
            skills: None,
            attachments: vec![id.clone()],
        },
    );
    let frames = call_frames(&h);
    let submit = frames.iter().find(|f| f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "submit").unwrap_or(false)).unwrap();
    assert_eq!(
        submit.get("args").and_then(|args| args.get("attachments")).cloned(),
        Some(Json::array(vec![Json::from(id.clone())]))
    );
    let create = frames.iter().find(|f| f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "createConversation").unwrap_or(false)).unwrap();
    assert_eq!(
        create.get("args").and_then(|args| args.get("attachments")).cloned(),
        Some(Json::array(vec![Json::from(id.clone())]))
    );

    let mut host = ScriptedHost::new();
    host.minor = 18.0;
    let mut h = Harness::boot(host, "req-1");
    h.invoke(
        1,
        FfiCall::Submit {
            text: "look".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: Some(2),
            request_id: Some("r".to_string()),
            images: vec![],
            skills: None,
            attachments: vec![id.clone()],
        },
    );
    h.invoke(
        2,
        FfiCall::CreateConversation {
            home: NewConversationHome::Chat,
            text: "go".to_string(),
            checkout: None,
            model: None,
            thinking_level: None,
            agent: None,
            images: vec![],
            skills: None,
            attachments: vec![id],
        },
    );
    assert_eq!(h.ops.get(&1), Some(&Ok(CallResult::Unit)));
    assert_eq!(h.ops.get(&2), Some(&Ok(CallResult::Unit)));
    assert!(call_frames(&h).iter().all(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() != "submit" && s.to_string_lossy() != "createConversation").unwrap_or(true)
    }));
    assert_eq!(
        h.client.snapshot().unwrap().notices.iter().filter(|notice| notice.message.contains("needs protocol 5.19")).count(),
        2
    );
}

#[test]
fn list_files_needs_a_5_10_host() {
    let mut host = ScriptedHost::new();
    host.minor = 9.0;
    let mut h = Harness::boot(host, "req-1");
    h.invoke(
        1,
        FfiCall::ListFiles { scope: FileScope::Conversation { conversation_id: 1 }, query: "".to_string() },
    );
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.10")));
    assert!(call_frames(&h).iter().all(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() != "listFiles").unwrap_or(true)
    }));
}

/// `createPairing`: a Request-class call whose success decodes to
/// `CallResult::Pairing`; on the wire since 5.0, so no version gate.
#[test]
fn create_pairing_resolves_a_typed_result() {
    let mut host = ScriptedHost::new();
    host.call_results.insert(
        "createPairing".to_string(),
        obj(&[
            ("url", Json::from("wss://host.example/ws#pair=aGk.c2VjcmV0")),
            ("expiresAt", Json::from(1700000000000.0)),
        ]),
    );
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::CreatePairing);
    assert_eq!(
        h.ops.get(&1),
        Some(&Ok(CallResult::Pairing {
            url: "wss://host.example/ws#pair=aGk.c2VjcmV0".to_string(),
            expires_at: 1700000000000.0,
        }))
    );
    let call = call_frames(&h).into_iter().find(|f| {
        f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == "createPairing").unwrap_or(false)
    });
    assert_eq!(call.and_then(|f| f.get("args").cloned()), Some(obj(&[])));
}

#[test]
fn create_pairing_result_malformed_or_error_fails_the_op() {
    for (index, value) in [
        obj(&[("url", Json::from("u"))]),                                             // missing expiresAt
        obj(&[("expiresAt", Json::from(1.0))]),                                       // missing url
        obj(&[("url", Json::from(1.0)), ("expiresAt", Json::from(2.0))]),             // bad url
        obj(&[("url", Json::from("u")), ("expiresAt", Json::from("soon"))]),          // bad expiresAt
        Json::Null,                                                                    // not an object
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = ScriptedHost::new();
        host.call_results.insert("createPairing".to_string(), value);
        let mut h = Harness::boot(host, "req-1");
        h.invoke(1, FfiCall::CreatePairing);
        match h.ops.get(&1) {
            Some(Err(error)) => assert!(error.contains("malformed createPairing result"), "#{index}: {error}"),
            other => panic!("#{index}: malformed value must fail the op, got {other:?}"),
        }
    }
    // A host-side `ok:false` is an OperationFailed too.
    let mut host = ScriptedHost::new();
    host.call_errors.insert("createPairing".to_string(), "remote access is off".to_string());
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::CreatePairing);
    assert_eq!(h.ops.get(&1), Some(&Err("remote access is off".to_string())));
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
fn snapshot_host_name_comes_from_the_settings_stream() {
    let mut host = ScriptedHost::new();
    host.snapshots.insert(
        "settings".to_string(),
        obj(&[("hostName", Json::from("Kieran's MacBook"))]),
    );
    let h = Harness::boot(host, "req-1");
    assert_eq!(
        h.client.snapshot().unwrap().host_name.as_deref(),
        Some("Kieran's MacBook")
    );
}

#[test]
fn snapshot_host_name_is_none_without_the_field() {
    // A pre-5.12 host's settings have no name; a stream that never arrives
    // is no name either.
    let h = Harness::boot(ScriptedHost::new(), "req-1");
    assert_eq!(h.client.snapshot().unwrap().host_name, None);
}

#[test]
fn snapshot_host_name_ignores_a_non_string_value() {
    let mut host = ScriptedHost::new();
    host.snapshots.insert("settings".to_string(), obj(&[("hostName", Json::from(12.0))]));
    let h = Harness::boot(host, "req-1");
    assert_eq!(h.client.snapshot().unwrap().host_name, None);
}

#[test]
fn snapshot_devices_decode_the_devices_stream() {
    let mut host = ScriptedHost::new();
    host.snapshots.insert(
        "devices".to_string(),
        obj(&[(
            "devices",
            Json::array(vec![
                obj(&[
                    ("publicKey", Json::from("a-key")),
                    ("name", Json::from("iPhone")),
                    ("pairedAt", Json::from(1700000000000.0)),
                    ("source", Json::from("account")),
                ]),
                // Entries from before sources existed, and a source this
                // client doesn't know, say nothing about how they paired.
                obj(&[("publicKey", Json::from("b-key")), ("name", Json::from("Mac")), ("pairedAt", Json::from(1.0))]),
                obj(&[
                    ("publicKey", Json::from("c-key")),
                    ("name", Json::from("Pad")),
                    ("pairedAt", Json::from(2.0)),
                    ("source", Json::from("carrier-pigeon")),
                ]),
                // No key, nothing to revoke: dropped.
                obj(&[("name", Json::from("ghost")), ("pairedAt", Json::from(3.0))]),
            ]),
        )]),
    );
    let h = Harness::boot(host, "req-1");
    assert_eq!(
        h.client.snapshot().unwrap().devices,
        vec![
            DeviceEntry {
                public_key: "a-key".to_string(),
                name: "iPhone".to_string(),
                paired_at: 1700000000000.0,
                source: Some(DeviceSource::Account),
            },
            DeviceEntry { public_key: "b-key".to_string(), name: "Mac".to_string(), paired_at: 1.0, source: None },
            DeviceEntry { public_key: "c-key".to_string(), name: "Pad".to_string(), paired_at: 2.0, source: None },
        ]
    );
}

#[test]
fn snapshot_settings_carry_the_account_switch_and_whether_the_name_is_custom() {
    let mut host = ScriptedHost::new();
    host.snapshots.insert(
        "settings".to_string(),
        obj(&[
            ("acceptAccountDevices", Json::Bool(false)),
            ("hostName", Json::from("studio")),
            ("custom", Json::array(vec![Json::from("steeringMode"), Json::from("hostName")])),
        ]),
    );
    let h = Harness::boot(host, "req-1");
    assert_eq!(
        h.client.snapshot().unwrap().settings,
        Some(HostSettingsState { accept_account_devices: false, host_name_custom: true })
    );

    // The machine's own name: nothing to reset to.
    let mut host = ScriptedHost::new();
    host.snapshots.insert(
        "settings".to_string(),
        obj(&[("acceptAccountDevices", Json::Bool(true)), ("custom", Json::array(vec![]))]),
    );
    let h = Harness::boot(host, "req-1");
    assert_eq!(
        h.client.snapshot().unwrap().settings,
        Some(HostSettingsState { accept_account_devices: true, host_name_custom: false })
    );
}

#[test]
fn snapshot_settings_are_none_until_the_stream_has_a_value() {
    let mut host = ScriptedHost::new();
    host.snapshots.insert("settings".to_string(), Json::Null);
    let h = Harness::boot(host, "req-1");
    assert_eq!(h.client.snapshot().unwrap().settings, None);
}

fn call_args(h: &Harness, method: &str) -> Vec<Json> {
    call_frames(h)
        .into_iter()
        .filter(|f| f.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == method).unwrap_or(false))
        .map(|f| f.get("args").cloned().unwrap_or(Json::Null))
        .collect()
}

/// The settings page's calls lower to the reference's `revokeDevice` and
/// single-key `updateSettings` patches; a `None` name is the reset.
#[test]
fn device_and_settings_calls_encode_the_reference_frames() {
    let mut h = Harness::new();
    h.invoke(1, FfiCall::RevokeDevice { public_key: "a-key".to_string() });
    h.invoke(2, FfiCall::SetHostName { name: Some("studio".to_string()) });
    h.invoke(3, FfiCall::SetHostName { name: None });
    h.invoke(4, FfiCall::SetAcceptAccountDevices { accept: false });
    assert_eq!(call_args(&h, "revokeDevice"), vec![obj(&[("publicKey", Json::from("a-key"))])]);
    assert_eq!(
        call_args(&h, "updateSettings"),
        vec![
            obj(&[("patch", obj(&[("hostName", Json::from("studio"))]))]),
            obj(&[("patch", obj(&[("hostName", Json::Null)]))]),
            obj(&[("patch", obj(&[("acceptAccountDevices", Json::Bool(false))]))]),
        ]
    );
    // Command-class, like the reference: the op settles as Unit.
    for op in 1..=4 {
        assert_eq!(h.ops.get(&op), Some(&Ok(CallResult::Unit)), "op {op}");
    }
}

#[test]
fn renaming_an_older_host_lands_a_notice_instead_of_a_frame() {
    let mut host = ScriptedHost::new();
    host.minor = 11.0;
    let mut h = Harness::boot(host, "req-1");
    h.invoke(1, FfiCall::SetHostName { name: None });
    assert_eq!(h.ops.get(&1), Some(&Ok(CallResult::Unit)));
    assert!(call_args(&h, "updateSettings").is_empty());
    let notices = &h.client.snapshot().unwrap().notices;
    assert!(notices.iter().any(|n| n.message.contains("5.12")), "{notices:?}");
}

#[test]
fn device_public_key_derives_the_key_the_host_lists() {
    let pair = pinomad_core::noise::generate_keypair().unwrap();
    let private = pinomad_core::b64::to_base64url(&pair.private_key);
    assert_eq!(device_public_key(private), Some(pinomad_core::b64::to_base64url(&pair.public_key)));
    assert_eq!(device_public_key("not a key".to_string()), None);
    assert_eq!(device_public_key(pinomad_core::b64::to_base64url(&[1, 2, 3])), None);
}

#[test]
fn connect_rejects_bad_key_material() {
    let result = PinomadClient::connect(StoredHost {
        url: "wss://host.example/".to_string(),
        host_key: "not base64url!!".to_string(),
        private_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        name: None,
        account: None,
    });
    assert!(matches!(result, Err(ClientError::KeyMaterial { .. })));
}

// ─── Account client ─────────────────────────────────────────────────────────
// Behavior coverage lives in the derive_vectors replay; these check that the
// FFI records round-trip through the facade conversions.

#[test]
fn account_request_builds_bearer_http() {
    use pinomad_core::ffi::{AccountOp, account_request};
    let request = account_request(
        "https://relay.example.com/".to_string(),
        Some("tok".to_string()),
        AccountOp::Login {
            username: "ad min".to_string(),
            password: "p\"w".to_string(),
        },
    );
    assert_eq!(request.method, "POST");
    assert_eq!(request.url, "https://relay.example.com/api/login");
    let headers: Vec<(&str, &str)> = request
        .headers
        .iter()
        .map(|h| (h.name.as_str(), h.value.as_str()))
        .collect();
    assert_eq!(
        headers,
        [("authorization", "Bearer tok"), ("content-type", "application/json")]
    );
    assert_eq!(
        request.body.as_deref(),
        Some(r#"{"username":"ad min","password":"p\"w"}"#)
    );

    // A path arg goes through encodeURIComponent.
    let request = account_request(
        "https://relay.example.com".to_string(),
        None,
        AccountOp::RequestPairing {
            host_id: "id a/b".to_string(),
        },
    );
    assert_eq!(request.url, "https://relay.example.com/api/hosts/id%20a%2Fb/pairing");
    assert_eq!(request.headers.len(), 0);
}

#[test]
fn account_response_parses_values_and_errors() {
    use pinomad_core::ffi::{AccountError, AccountOpKind, AccountValue, account_response};
    let ok = account_response(
        AccountOpKind::Login,
        200,
        r#"{"user":{"username":"a"},"expiresAt":1,"token":"t"}"#.to_string(),
    );
    let AccountValue::Login(login) = ok.unwrap() else {
        panic!("expected a login result")
    };
    assert_eq!(login.user.username, "a");
    assert_eq!(login.token.as_deref(), Some("t"));

    // The server's `error` code passes through verbatim, with the status.
    let err = account_response(AccountOpKind::ListHosts, 429, r#"{"error":"rate_limited"}"#.to_string());
    assert_eq!(
        err.err(),
        Some(AccountError::Api {
            code: "rate_limited".to_string(),
            status: Some(429)
        })
    );
    // A 2xx that fails the shape check is invalid_response with no status.
    let err = account_response(AccountOpKind::Me, 200, "<html>x</html>".to_string());
    assert_eq!(
        err.err(),
        Some(AccountError::Api {
            code: "invalid_response".to_string(),
            status: None
        })
    );
}

#[test]
fn account_probe_and_origin_helpers() {
    use pinomad_core::ffi::{
        AccountsProbe, account_probe_request, is_secure_server_origin, normalize_server_origin, probe_verdict,
    };
    let probe = account_probe_request("https://relay.example.com/".to_string());
    assert_eq!(probe.url, "https://relay.example.com/api/me");
    assert!(probe.headers.is_empty() && probe.body.is_none());
    assert_eq!(probe_verdict(Some(401), None), AccountsProbe::Enabled);
    assert_eq!(probe_verdict(None, None), AccountsProbe::Unreachable);
    assert_eq!(
        probe_verdict(Some(200), Some("<html>".to_string())),
        AccountsProbe::Disabled
    );
    assert!(is_secure_server_origin("http://localhost:7430".to_string()));
    assert!(!is_secure_server_origin("http://relay.example.com".to_string()));
    assert_eq!(
        normalize_server_origin("HTTPS://relay.example.com:443/".to_string()),
        "https://relay.example.com"
    );
}

#[test]
fn account_pairing_link_and_host_matching() {
    use pinomad_core::ffi::{
        AccountHost, AccountHostPairing, AccountHostStatus, PairingOffer, StoredHostAccount, account_pairing_link,
        match_account_hosts, pairing_target,
    };
    let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let secret = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let offer = PairingOffer {
        url: "wss://relay.example.com/c/h".to_string(),
        host_key: key.to_string(),
        secret: secret.to_string(),
        expires_at: 1.0,
    };
    // The produced link is acceptable to the existing pairing flow.
    let link = account_pairing_link(offer.clone()).expect("valid offer links");
    let target = pairing_target(link).expect("the offer link parses");
    assert_eq!(target.url, "wss://relay.example.com/c/h");
    assert_eq!(target.host_key, key);
    // A malformed offer is refused before a socket opens.
    assert_eq!(
        account_pairing_link(PairingOffer {
            url: "https://not-a-socket".to_string(),
            ..offer
        }),
        None
    );

    let host = AccountHost {
        host_id: key.to_string(),
        name: "omarchy".to_string(),
        noise_public_key: secret.to_string(),
        online: true,
        last_seen_at: 1.0,
        pairing: AccountHostPairing::Available,
    };
    // Linked entry: same origin+hostId, matching key → paired, not linkable.
    let linked = StoredHost {
        url: "wss://relay.example.com/c/x".to_string(),
        host_key: secret.to_string(),
        private_key: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC".to_string(),
        name: None,
        account: Some(StoredHostAccount {
            server_origin: "https://relay.example.com/".to_string(),
            host_id: key.to_string(),
        }),
    };
    let matches = match_account_hosts("https://relay.example.com".to_string(), vec![host.clone()], vec![linked]);
    assert_eq!(matches[0].status, AccountHostStatus::Paired);
    assert_eq!(matches[0].stored.as_ref().map(|s| s.host_key.as_str()), Some(secret));
    assert!(!matches[0].linkable);
    // Nothing stored: unpaired.
    let matches = match_account_hosts("https://relay.example.com".to_string(), vec![host], vec![]);
    assert_eq!(matches[0].status, AccountHostStatus::Unpaired);
}

#[test]
fn ffi_forwards_bound_skills() {
    let mut h = Harness::new();
    h.invoke(1, FfiCall::SwitchConversation { id: 1 });
    h.invoke(
        2,
        FfiCall::Submit {
            text: "$review x".to_string(),
            when_busy: SubmitMode::FollowUp,
            target: None,
            request_id: None,
            images: vec![],
            skills: Some(vec!["review".to_string()]),
            attachments: vec![],
        },
    );
    let frames = call_frames(&h);
    assert_eq!(
        frames[0].get("args").and_then(|args| args.get("skills")).cloned(),
        Some(Json::array(vec![Json::from("review")]))
    );
}
