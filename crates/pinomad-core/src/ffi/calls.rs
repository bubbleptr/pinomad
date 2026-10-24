// The calls the mobile client can issue — a deliberately smaller surface
// than the core `Call` enum, with typed arguments shaped like the wire
// (packages/protocol is the reference). `into_core` lowers each variant to
// the generic core call, which produces the same call frame the TS client
// sends.

use std::sync::Arc;

use crate::ffi::types::{ApnsPushToken, ImageVariant, MessageImage, ModelRef, QuestionAnswer, ThinkingLevel};
use crate::ffi::providers::{ApiKeyChange, CustomProviderApi, CustomProviderInput, LoginMethod};
use crate::ffi::ResultKind;
use crate::json::{Json, JsonObject};
use crate::remote_durable::Call;
use crate::u16str::U16String;

fn set(obj: &mut JsonObject, name: &str, value: Json) {
    obj.set(U16String::from_str(name), value);
}

/// `submit`'s `whenBusy`: steer the running turn, or queue a follow-up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SubmitMode {
    Steer,
    FollowUp,
}

impl SubmitMode {
    fn as_str(self) -> &'static str {
        match self {
            SubmitMode::Steer => "steer",
            SubmitMode::FollowUp => "followUp",
        }
    }
}

/// `createConversation`'s `checkout`: the worktree default or the project
/// directory itself (view.ts `checkout?: "worktree" | "project"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ConversationCheckout {
    Worktree,
    Project,
}

impl ConversationCheckout {
    fn as_str(self) -> &'static str {
        match self {
            ConversationCheckout::Worktree => "worktree",
            ConversationCheckout::Project => "project",
        }
    }
}

/// `listFiles`'s `scope`: the wire union `{kind:"conversation",
/// conversationId}` | `{kind:"project", path, checkout}` (5.10).
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum FileScope {
    /// The conversation's persisted working directory.
    Conversation { conversation_id: u64 },
    /// A registered project's directory: its live files, or the committed
    /// HEAD tree a fresh worktree would hold.
    Project { path: String, checkout: ConversationCheckout },
}

impl FileScope {
    fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        match self {
            FileScope::Conversation { conversation_id } => {
                set(&mut object, "kind", Json::from("conversation"));
                set(&mut object, "conversationId", Json::Number(*conversation_id as f64));
            }
            FileScope::Project { path, checkout } => {
                set(&mut object, "kind", Json::from("project"));
                set(&mut object, "path", Json::from(path.clone()));
                set(&mut object, "checkout", Json::from(checkout.as_str()));
            }
        }
        Json::Object(Arc::new(object))
    }
}

/// `createConversation`'s `home`: the wire union `{kind:"chat"}` |
/// `{kind:"project", path}`.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum NewConversationHome {
    Chat,
    Project { path: String },
}

impl NewConversationHome {
    fn to_json(&self) -> Json {
        match self {
            NewConversationHome::Chat => {
                let mut object = JsonObject::new();
                set(&mut object, "kind", Json::from("chat"));
                Json::Object(Arc::new(object))
            }
            NewConversationHome::Project { path } => {
                let mut object = JsonObject::new();
                set(&mut object, "kind", Json::from("project"));
                set(&mut object, "path", Json::from(path.clone()));
                Json::Object(Arc::new(object))
            }
        }
    }
}

/// `listSkills`'s `scope`: the wire union `{kind:"conversation",
/// conversationId}` | `{kind:"project", path, checkout}` | `{kind:"chat"}`
/// (5.13). Like `FileScope`, plus the Chat draft's user-only listing.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum SkillScope {
    /// The conversation's persisted working directory.
    Conversation { conversation_id: u64 },
    /// A registered project's directory: its live entry, or the committed
    /// HEAD tree a fresh worktree would hold.
    Project { path: String, checkout: ConversationCheckout },
    /// A Chat draft: the user skills alone.
    Chat,
}

impl SkillScope {
    fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        match self {
            SkillScope::Conversation { conversation_id } => {
                set(&mut object, "kind", Json::from("conversation"));
                set(&mut object, "conversationId", Json::Number(*conversation_id as f64));
            }
            SkillScope::Project { path, checkout } => {
                set(&mut object, "kind", Json::from("project"));
                set(&mut object, "path", Json::from(path.clone()));
                set(&mut object, "checkout", Json::from(checkout.as_str()));
            }
            SkillScope::Chat => {
                set(&mut object, "kind", Json::from("chat"));
            }
        }
        Json::Object(Arc::new(object))
    }
}

/// A one-key `updateSettings` patch; `null` clears PiNomad's value.
fn settings_patch(key: &str, value: Json) -> Json {
    let mut object = JsonObject::new();
    set(&mut object, key, value);
    Json::Object(Arc::new(object))
}

fn images_json(images: &[MessageImage]) -> Vec<Json> {
    // Bytes stay inline; a ref-form image goes back as `{ ref }` and the host
    // answers with the type it recorded (ADR-0027).
    images.iter().map(MessageImage::to_outgoing_json).collect()
}

fn answers_json(answers: &[QuestionAnswer]) -> Json {
    Json::array(
        answers
            .iter()
            .map(|answer| {
                let mut object = JsonObject::new();
                set(
                    &mut object,
                    "selected",
                    Json::array(answer.selected.iter().map(|s| Json::from(s.clone())).collect()),
                );
                if let Some(other) = &answer.other {
                    set(&mut object, "other", Json::from(other.clone()));
                }
                Json::Object(Arc::new(object))
            })
            .collect(),
    )
}

/// Every call the mobile UI can make, as typed data. `OperationFailed`
/// only ever answers the Request-class variants (`AddProject`,
/// `ListFolders`, `RenameConversation`, `SetPushToken`, `Changes`,
/// `CreatePairing`, `WithdrawQueued`, `SteerQueued`, and the provider calls
/// `BeginLogin` … `RemoveCustomProvider`) and the out-of-queue `ListFiles`,
/// `ListSkills`, `Image` and `ListEndpointModels`; the rest fail into a view notice
/// while reporting `OperationSucceeded { value: Unit }`.
#[derive(Clone, Debug, uniffi::Enum)]
pub enum FfiCall {
    /// Prompt when idle; otherwise steer or queue a follow-up. `target`
    /// defaults to the shown conversation; `request_id` is the
    /// idempotency key (a retry reuses it so a double submit admits once).
    Submit {
        text: String,
        when_busy: SubmitMode,
        target: Option<u64>,
        request_id: Option<String>,
        images: Vec<MessageImage>,
        /// The `$` menu picks, deduplicated, in mention order (ADR-0028);
        /// sent to a 5.16 host only. `None` (the default) leaves an older
        /// composer's `$name` text to the host's own matching.
        #[uniffi(default)]
        skills: Option<Vec<String>>,
        /// Host-stored attachment ids (issue #321, 5.19); an older host is
        /// refused locally instead of being sent a field it calls malformed.
        #[uniffi(default)]
        attachments: Vec<String>,
    },
    /// Show and talk to another conversation.
    SwitchConversation { id: u64 },
    /// The shown conversation's thinking level.
    SetThinkingLevel { level: ThinkingLevel },
    SetModel { model: ModelRef },
    /// Switch the shown conversation to a named agent, or clear it with
    /// `None` (ADR-0023, protocol 5.18). Needs a 5.18 host — an older one
    /// lands a notice.
    SetAgent { agent: Option<String> },
    /// Rename a conversation permanently. Request-class: the op rejects
    /// with the host's error. Needs a 5.4 host.
    RenameConversation { id: u64, title: String },
    /// One page of the folder picker. Request-class; resolves with
    /// `CallResult::FolderListing`. Needs a 5.3 host.
    ListFolders { path: Option<String> },
    /// Create a conversation at a home, send `text`, and show it.
    /// Command-class: resolves `Unit` — the new conversation is the
    /// snapshot's `conversation` after the op lands.
    CreateConversation {
        home: NewConversationHome,
        text: String,
        /// `checkout` selects the project dir over the worktree default.
        checkout: Option<ConversationCheckout>,
        /// Overrides the host default for the new agent.
        model: Option<ModelRef>,
        /// Clamps to the model's levels on the host.
        thinking_level: Option<ThinkingLevel>,
        /// A named agent to create the conversation with (ADR-0023); needs
        /// a 5.10 host — the op fails with an upgrade notice otherwise.
        agent: Option<String>,
        /// Up to 4 attached images; needs a 5.5 host.
        images: Vec<MessageImage>,
        /// The `$` menu picks, deduplicated, in mention order (ADR-0028);
        /// sent to a 5.16 host only. `None` (the default) leaves an older
        /// composer's `$name` text to the host's own matching.
        #[uniffi(default)]
        skills: Option<Vec<String>>,
        /// Host-stored attachment ids (issue #321, 5.19); an older host is
        /// refused locally.
        #[uniffi(default)]
        attachments: Vec<String>,
    },
    Compact { instructions: Option<String> },
    /// Run the host-declared command `name` (from `ListCommands`) on
    /// `target`, the shown conversation by default; `args` is the text
    /// after the name — `parse_command_input` splits a draft into both
    /// (ADR-0029). Command-class like `Compact`: resolves `Unit`, and a
    /// failure (an unknown name, a pre-5.17 host) lands in
    /// `snapshot().notices`. Needs a 5.17 host.
    RunCommand { name: String, args: Option<String>, target: Option<u64> },
    /// Answer a pending `pinomad.question` request on `target` (the shown
    /// conversation by default).
    Answer {
        kind: String,
        request_id: String,
        answers: Vec<QuestionAnswer>,
        target: Option<u64>,
    },
    /// Register a local directory as a project. Request-class; resolves
    /// with `CallResult::Project`.
    AddProject { path: String },
    /// Abort `target`'s run (the shown conversation's by default). Not
    /// queued behind the serialized commands.
    Abort { target: Option<u64> },
    /// Take a queued input out of `target`'s inbox (the shown conversation by
    /// default). Request-class; resolves `CallResult::WithdrawQueued`. Needs a
    /// 5.14 host.
    WithdrawQueued { submission_id: u64, target: Option<u64> },
    /// Promote a queued follow-up to steer in place on `target`. Request-class;
    /// resolves `CallResult::SteerQueued`. Needs a 5.14 host.
    SteerQueued { submission_id: u64, target: Option<u64> },
    /// Hide or restore a top-level conversation in the index.
    Archive { id: u64, archived: bool },
    /// Register (`Some`) or clear (`None`) this device's APNs token.
    /// Request-class. The `{apns, environment}` form needs a 5.9 host.
    SetPushToken { token: Option<ApnsPushToken> },
    /// The conversation's file changes, already parsed — the payload can
    /// reach 1 MiB, so it rides a call result, not the snapshot (ADR-0024
    /// §5). `conversation_id` defaults to the shown conversation, like
    /// `submit`'s `target`. Request-class; resolves `CallResult::Changes`.
    /// On the wire since 5.0 — no version gate.
    Changes { conversation_id: Option<u64> },
    /// A one-time pairing offer for another device to scan (ADR-0022 §7).
    /// Request-class; resolves `CallResult::Pairing`. On the wire since
    /// 5.0 — no version gate.
    CreatePairing,
    /// Unpair a device by its `DeviceEntry::public_key`; this device's own
    /// key ends this connection with 4401. On the wire since 5.0.
    RevokeDevice { public_key: String },
    /// Rename the machine for every paired device; `None` resets to the
    /// machine's own name. Needs a 5.12 host — an older one lands a notice.
    SetHostName { name: Option<String> },
    /// Whether the joined server may vouch for new devices (ADR-0022 §6).
    /// Needs a 5.8 host — an older one lands a notice.
    SetAcceptAccountDevices { accept: bool },
    /// File candidates under `scope`'s root for `@./path` completion.
    /// Request-class, but sent outside the command queue — a slow scan
    /// must not stall submits or switches. Resolves `CallResult::Files`.
    /// Needs a 5.10 host.
    ListFiles { scope: FileScope, query: String },
    /// The `$`-mentionable skills for `scope` (issue #143) — name,
    /// description, and whether the project or the user entry supplied it.
    /// Request-class, sent outside the command queue like `listFiles`.
    /// Resolves `CallResult::Skills`. Needs a 5.13 host.
    ListSkills { scope: SkillScope },
    /// The bytes behind an image ref (5.15, ADR-0027). Read-only, outside
    /// the command queue like `listFiles`; resolves `CallResult::Image`.
    Image {
        #[uniffi(name = "ref")]
        ref_: String,
        #[uniffi(default = None)]
        variant: Option<ImageVariant>,
    },
    /// The slash commands the host declares for `conversation_id` (ADR-0029)
    /// — there is no client-side fallback list. Request-class, sent outside
    /// the command queue like `listSkills`. Resolves `CallResult::Commands`.
    /// Needs a 5.17 host.
    ListCommands { conversation_id: u64 },
    /// Create one host-stored upload slot (5.19, issue #321). Resolves
    /// `CallResult::BeginAttachment`; sent outside the command queue like
    /// `listFiles`, so chunks never wait behind a submit.
    BeginAttachment { name: String, size: u64 },
    /// Append one base64 chunk at `offset` (5.19); the host answers the
    /// bytes it actually holds so a retry resumes instead of guessing.
    AppendAttachment { attachment_id: String, offset: u64, data: String },
    /// Remove a provider's stored credential on the host. Command-class: a
    /// failure lands in `snapshot().notices`. Needs a 5.1 host.
    Logout { provider_id: String },
    /// Start a login (ADR-0031); its prompts and outcome arrive in
    /// `snapshot().providers.logins`. Request-class: rejects when the
    /// provider lacks `method` or already has a login running. Resolves
    /// `CallResult::LoginStarted`. Needs a 5.21 host, like the calls below.
    BeginLogin { provider_id: String, method: LoginMethod },
    /// Answer a running login's current prompt; a stale `prompt_id` is
    /// rejected, never applied to a later prompt. Request-class.
    AnswerLogin { login_id: String, prompt_id: u64, value: String },
    /// Abort a running login; ended or unknown ids are a no-op. Request-class.
    CancelLogin { login_id: String },
    /// Add or replace a custom endpoint. Request-class.
    SaveCustomProvider { provider: CustomProviderInput, api_key: ApiKeyChange },
    /// Remove a custom endpoint and its stored key. Request-class.
    RemoveCustomProvider { provider_id: String },
    /// The models an endpoint serves, asked from the host (it may be the only
    /// machine that reaches it). `provider_id` reuses that custom endpoint's
    /// stored key when `api_key` is absent. Request-class, outside the command
    /// queue like `listFiles` — the host waits on the endpoint. Resolves
    /// `CallResult::EndpointModels`.
    ListEndpointModels {
        api: CustomProviderApi,
        base_url: String,
        api_key: Option<String>,
        provider_id: Option<String>,
    },
}

impl FfiCall {
    /// Which typed `CallResult` this call's success value decodes to —
    /// only Request-class calls with a meaningful payload.
    pub(crate) fn result_kind(&self) -> Option<ResultKind> {
        match self {
            FfiCall::AddProject { .. } => Some(ResultKind::Project),
            FfiCall::ListFolders { .. } => Some(ResultKind::FolderListing),
            FfiCall::Changes { .. } => Some(ResultKind::Changes),
            FfiCall::CreatePairing => Some(ResultKind::Pairing),
            FfiCall::ListFiles { .. } => Some(ResultKind::Files),
            FfiCall::ListSkills { .. } => Some(ResultKind::Skills),
            FfiCall::Image { .. } => Some(ResultKind::Image),
            FfiCall::ListCommands { .. } => Some(ResultKind::Commands),
            FfiCall::BeginAttachment { .. } => Some(ResultKind::BeginAttachment),
            FfiCall::AppendAttachment { .. } => Some(ResultKind::AppendAttachment),
            FfiCall::WithdrawQueued { .. } => Some(ResultKind::WithdrawQueued),
            FfiCall::SteerQueued { .. } => Some(ResultKind::SteerQueued),
            FfiCall::BeginLogin { .. } => Some(ResultKind::LoginStarted),
            FfiCall::ListEndpointModels { .. } => Some(ResultKind::EndpointModels),
            _ => None,
        }
    }

    /// The generic core call — what `RemoteDurable` turns into a wire frame.
    pub fn into_core(self) -> Call {
        match self {
            FfiCall::Submit {
                text,
                when_busy,
                target,
                request_id,
                images,
                skills,
                attachments,
            } => Call::Submit {
                text,
                when_busy: when_busy.as_str().to_string(),
                target,
                request_id,
                images: images_json(&images),
                skills,
                attachments,
            },
            FfiCall::SwitchConversation { id } => Call::SwitchConversation { id },
            FfiCall::SetThinkingLevel { level } => Call::SetThinkingLevel {
                level: level.as_str().to_string(),
            },
            FfiCall::SetModel { model } => Call::SetModel {
                model: model.to_json(),
            },
            FfiCall::SetAgent { agent } => Call::SetAgent { agent },
            FfiCall::RenameConversation { id, title } => Call::RenameConversation { id, title },
            FfiCall::ListFolders { path } => Call::ListFolders { path },
            FfiCall::CreateConversation {
                home,
                text,
                checkout,
                model,
                thinking_level,
                agent,
                images,
                skills,
                attachments,
            } => Call::CreateConversation {
                home: home.to_json(),
                text,
                checkout: checkout.map(|c| Json::from(c.as_str())),
                model: model.map(|m| m.to_json()),
                thinking_level: thinking_level.map(|l| l.as_str().to_string()),
                agent,
                images: images_json(&images),
                skills,
                attachments,
            },
            FfiCall::Compact { instructions } => Call::Compact { instructions },
            FfiCall::RunCommand { name, args, target } => Call::RunCommand { name, args, target },
            FfiCall::Answer {
                kind,
                request_id,
                answers,
                target,
            } => Call::Answer {
                kind,
                request_id,
                answers: answers_json(&answers),
                target,
            },
            FfiCall::AddProject { path } => Call::AddProject { path },
            FfiCall::Abort { target } => Call::Abort { target },
            FfiCall::WithdrawQueued { submission_id, target } => {
                Call::WithdrawQueued { submission_id, target }
            }
            FfiCall::SteerQueued { submission_id, target } => {
                Call::SteerQueued { submission_id, target }
            }
            FfiCall::Archive { id, archived } => Call::Archive { id, archived },
            FfiCall::SetPushToken { token } => Call::SetPushToken { token },
            FfiCall::Changes { conversation_id } => Call::Changes {
                target: conversation_id,
            },
            FfiCall::CreatePairing => Call::CreatePairing,
            FfiCall::RevokeDevice { public_key } => Call::RevokeDevice { public_key },
            FfiCall::SetHostName { name } => Call::UpdateSettings {
                patch: settings_patch("hostName", name.map(Json::from).unwrap_or(Json::Null)),
            },
            FfiCall::SetAcceptAccountDevices { accept } => Call::UpdateSettings {
                patch: settings_patch("acceptAccountDevices", Json::Bool(accept)),
            },
            FfiCall::ListFiles { scope, query } => Call::ListFiles {
                scope: scope.to_json(),
                query,
            },
            FfiCall::ListSkills { scope } => Call::ListSkills {
                scope: scope.to_json(),
            },
            FfiCall::Image { ref_, variant } => Call::Image { ref_, variant: variant.unwrap_or_default() },
            FfiCall::ListCommands { conversation_id } => Call::ListCommands { conversation_id },
            FfiCall::BeginAttachment { name, size } => Call::BeginAttachment { name, size },
            FfiCall::AppendAttachment { attachment_id, offset, data } => {
                Call::AppendAttachment { attachment_id, offset, data }
            }
            FfiCall::Logout { provider_id } => Call::Logout { provider_id },
            FfiCall::BeginLogin { provider_id, method } => Call::BeginLogin {
                provider_id,
                method: method.into_core(),
            },
            FfiCall::AnswerLogin { login_id, prompt_id, value } => {
                Call::AnswerLogin { login_id, prompt_id, value }
            }
            FfiCall::CancelLogin { login_id } => Call::CancelLogin { login_id },
            FfiCall::SaveCustomProvider { provider, api_key } => Call::SaveCustomProvider {
                provider: provider.to_json(),
                api_key: api_key.into_core(),
            },
            FfiCall::RemoveCustomProvider { provider_id } => Call::RemoveCustomProvider { provider_id },
            FfiCall::ListEndpointModels { api, base_url, api_key, provider_id } => Call::ListEndpointModels {
                api: api.into_core(),
                base_url,
                api_key,
                provider_id,
            },
        }
    }
}


