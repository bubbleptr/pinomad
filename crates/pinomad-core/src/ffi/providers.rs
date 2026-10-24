// The `providers` host stream (5.21, ADR-0031) and the provider calls'
// arguments and results, typed for the platform (auth.ts is the reference).
// Decoding is lenient like `agents_of`: a field that doesn't fit is dropped,
// an event or prompt of a type this client doesn't know is skipped.

use std::sync::Arc;

use crate::json::{Json, JsonObject};
use crate::remote_durable::{ApiKeyChange as CoreApiKeyChange, CustomProviderApi as CoreApi, LoginMethod as CoreMethod};
use crate::u16str::U16String;

/// How a login is done (auth.ts `LoginMethod`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum LoginMethod {
    Oauth,
    ApiKey,
}

impl LoginMethod {
    fn from_str(text: &str) -> Option<Self> {
        match text {
            "oauth" => Some(LoginMethod::Oauth),
            "api_key" => Some(LoginMethod::ApiKey),
            _ => None,
        }
    }

    pub(crate) fn into_core(self) -> CoreMethod {
        match self {
            LoginMethod::Oauth => CoreMethod::Oauth,
            LoginMethod::ApiKey => CoreMethod::ApiKey,
        }
    }
}

/// The wire formats a custom endpoint may speak (auth.ts `CUSTOM_PROVIDER_APIS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum CustomProviderApi {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
    GoogleGenerativeAi,
}

impl CustomProviderApi {
    fn from_str(text: &str) -> Option<Self> {
        match text {
            "openai-completions" => Some(CustomProviderApi::OpenaiCompletions),
            "openai-responses" => Some(CustomProviderApi::OpenaiResponses),
            "anthropic-messages" => Some(CustomProviderApi::AnthropicMessages),
            "google-generative-ai" => Some(CustomProviderApi::GoogleGenerativeAi),
            _ => None,
        }
    }

    pub(crate) fn into_core(self) -> CoreApi {
        match self {
            CustomProviderApi::OpenaiCompletions => CoreApi::OpenaiCompletions,
            CustomProviderApi::OpenaiResponses => CoreApi::OpenaiResponses,
            CustomProviderApi::AnthropicMessages => CoreApi::AnthropicMessages,
            CustomProviderApi::GoogleGenerativeAi => CoreApi::GoogleGenerativeAi,
        }
    }
}

/// Sign-in through the provider's site (`ProviderInfo.oauth`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ProviderOAuth {
    /// pi's label for the method, e.g. "Anthropic (Claude Pro/Max)".
    pub name: String,
    /// A plan the user pays for, not per-token billing.
    pub subscription: bool,
    /// The provider's wording for the sign-in button.
    pub login_label: Option<String>,
}

/// The credential stored on the host for a provider (`ProviderInfo.stored`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct StoredCredential {
    pub kind: LoginMethod,
    pub subscription: bool,
}

/// An endpoint the user added (auth.ts `CustomProvider`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CustomProvider {
    pub api: CustomProviderApi,
    pub base_url: String,
    /// Model ids as the endpoint names them, in the user's order.
    pub models: Vec<String>,
}

/// One provider the host can reach models through (auth.ts `ProviderInfo`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub oauth: Option<ProviderOAuth>,
    /// Present when the provider takes a pasted key; pi's label for it.
    pub api_key: Option<String>,
    pub stored: Option<StoredCredential>,
    /// The environment variable (or other ambient source) configuring the
    /// provider when nothing is stored.
    pub ambient: Option<String>,
    /// Present exactly for endpoints the user added.
    pub custom: Option<CustomProvider>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LoginLink {
    pub url: String,
    pub label: Option<String>,
}

/// Something a login wants the user to see (auth.ts `LoginEvent`).
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum LoginEvent {
    Info { message: String, links: Vec<LoginLink> },
    AuthUrl { url: String, instructions: Option<String> },
    /// `expires_at` is epoch ms.
    DeviceCode { user_code: String, verification_uri: String, expires_at: Option<f64> },
    Progress { message: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LoginOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

/// What a prompt takes. Text may be answered empty ("blank for the
/// default"); the others need a value.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum LoginInput {
    Text { placeholder: Option<String> },
    Secret { placeholder: Option<String> },
    /// A code or redirect URL pasted back from the browser.
    ManualCode { placeholder: Option<String> },
    Select { options: Vec<LoginOption> },
}

/// Input a login waits for; `id` is what `AnswerLogin` names.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LoginPrompt {
    pub id: u64,
    pub message: String,
    pub input: LoginInput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum LoginState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

/// One login in progress or just ended (auth.ts `LoginFlow`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LoginFlow {
    pub id: String,
    pub provider_id: String,
    pub method: LoginMethod,
    /// Oldest first.
    pub events: Vec<LoginEvent>,
    /// Set while the login waits for an answer. A prompt of a type this
    /// client doesn't know reads as none: the flow shows as working, and
    /// the user can still cancel it.
    pub prompt: Option<LoginPrompt>,
    pub state: LoginState,
    /// Set when `state` is `Failed`.
    pub error: Option<String>,
}

/// The `providers` stream's value.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HostProviders {
    /// Built-in providers by name, then custom endpoints by name.
    pub providers: Vec<ProviderInfo>,
    pub logins: Vec<LoginFlow>,
}

/// `SaveCustomProvider`'s endpoint (auth.ts `CustomProviderInput`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CustomProviderInput {
    /// Lowercase letters, digits and `-`; must not name a built-in provider.
    pub id: String,
    pub name: String,
    pub api: CustomProviderApi,
    pub base_url: String,
    pub models: Vec<String>,
}

impl CustomProviderInput {
    pub(crate) fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        let mut set = |name: &str, value: Json| object.set(U16String::from_str(name), value);
        set("id", Json::from(self.id.clone()));
        set("name", Json::from(self.name.clone()));
        set("api", Json::from(self.api.into_core().as_str()));
        set("baseUrl", Json::from(self.base_url.clone()));
        set("models", Json::array(self.models.iter().map(|m| Json::from(m.clone())).collect()));
        Json::Object(Arc::new(object))
    }
}

/// `SaveCustomProvider`'s key: keep the stored one, remove it, or store `key`.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum ApiKeyChange {
    Keep,
    Remove,
    Set { key: String },
}

impl ApiKeyChange {
    pub(crate) fn into_core(self) -> CoreApiKeyChange {
        match self {
            ApiKeyChange::Keep => CoreApiKeyChange::Keep,
            ApiKeyChange::Remove => CoreApiKeyChange::Remove,
            ApiKeyChange::Set { key } => CoreApiKeyChange::Set(key),
        }
    }
}

fn text(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(|s| s.to_string_lossy())
}

fn flag(value: &Json, key: &str) -> bool {
    matches!(value.get(key), Some(Json::Bool(true)))
}

fn objects<'a>(value: &'a Json, key: &str) -> impl Iterator<Item = &'a Json> {
    value
        .get(key)
        .and_then(Json::as_array)
        .map(|list| list.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|entry| entry.is_object())
}

fn strings(value: &Json, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Json::as_array)
        .map(|list| list.iter().filter_map(|s| s.as_str().map(|s| s.to_string_lossy())).collect())
        .unwrap_or_default()
}

fn custom_of(value: &Json) -> Option<CustomProvider> {
    Some(CustomProvider {
        api: CustomProviderApi::from_str(&text(value, "api")?)?,
        base_url: text(value, "baseUrl")?,
        models: strings(value, "models"),
    })
}

fn provider_of(value: &Json) -> Option<ProviderInfo> {
    let id = text(value, "id")?;
    let oauth = value.get("oauth").filter(|v| v.is_object()).map(|oauth| ProviderOAuth {
        name: text(oauth, "name").unwrap_or_default(),
        subscription: flag(oauth, "subscription"),
        login_label: text(oauth, "loginLabel"),
    });
    let stored = value.get("stored").filter(|v| v.is_object()).and_then(|stored| {
        Some(StoredCredential {
            kind: LoginMethod::from_str(&text(stored, "kind")?)?,
            subscription: flag(stored, "subscription"),
        })
    });
    Some(ProviderInfo {
        name: text(value, "name").unwrap_or_else(|| id.clone()),
        id,
        oauth,
        api_key: value
            .get("apiKey")
            .filter(|v| v.is_object())
            .map(|key| text(key, "name").unwrap_or_default()),
        stored,
        ambient: text(value, "ambient"),
        custom: value.get("custom").filter(|v| v.is_object()).and_then(custom_of),
    })
}

fn event_of(value: &Json) -> Option<LoginEvent> {
    match text(value, "type")?.as_str() {
        "info" => Some(LoginEvent::Info {
            message: text(value, "message")?,
            links: objects(value, "links")
                .filter_map(|link| Some(LoginLink { url: text(link, "url")?, label: text(link, "label") }))
                .collect(),
        }),
        "auth_url" => Some(LoginEvent::AuthUrl {
            url: text(value, "url")?,
            instructions: text(value, "instructions"),
        }),
        "device_code" => Some(LoginEvent::DeviceCode {
            user_code: text(value, "userCode")?,
            verification_uri: text(value, "verificationUri")?,
            expires_at: value.get("expiresAt").and_then(Json::as_number),
        }),
        "progress" => Some(LoginEvent::Progress { message: text(value, "message")? }),
        _ => None,
    }
}

fn prompt_of(value: &Json) -> Option<LoginPrompt> {
    let id = crate::json::num_key(value.get("id"))?;
    let placeholder = text(value, "placeholder");
    let input = match text(value, "type")?.as_str() {
        "text" => LoginInput::Text { placeholder },
        "secret" => LoginInput::Secret { placeholder },
        "manual_code" => LoginInput::ManualCode { placeholder },
        "select" => LoginInput::Select {
            options: objects(value, "options")
                .filter_map(|option| {
                    Some(LoginOption {
                        id: text(option, "id")?,
                        label: text(option, "label")?,
                        description: text(option, "description"),
                    })
                })
                .collect(),
        },
        _ => return None,
    };
    Some(LoginPrompt { id, message: text(value, "message").unwrap_or_default(), input })
}

fn flow_of(value: &Json) -> Option<LoginFlow> {
    let state = match text(value, "state")?.as_str() {
        "running" => LoginState::Running,
        "succeeded" => LoginState::Succeeded,
        "failed" => LoginState::Failed,
        "cancelled" => LoginState::Cancelled,
        _ => return None,
    };
    Some(LoginFlow {
        id: text(value, "id")?,
        provider_id: text(value, "providerId")?,
        method: LoginMethod::from_str(&text(value, "method")?)?,
        events: objects(value, "events").filter_map(event_of).collect(),
        prompt: value.get("prompt").filter(|v| v.is_object()).and_then(prompt_of),
        state,
        error: text(value, "error"),
    })
}

/// The view's `providers`: `null` (a host before 5.21, or the stream hasn't
/// landed) is `None`.
pub(crate) fn providers_of(view: &Json) -> Option<HostProviders> {
    let providers = view.get("providers").filter(|v| v.is_object())?;
    Some(HostProviders {
        providers: objects(providers, "providers").filter_map(provider_of).collect(),
        logins: objects(providers, "logins").filter_map(flow_of).collect(),
    })
}

/// `beginLogin`'s `{ loginId }`; strict like the other typed results.
pub(crate) fn login_started_of(value: Option<&Json>) -> Result<String, String> {
    value
        .filter(|v| v.is_object())
        .and_then(|v| v.get("loginId"))
        .and_then(Json::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string_lossy())
        .ok_or_else(|| "malformed beginLogin result: loginId".to_string())
}

/// `listEndpointModels`' `{ models }`: every entry a string.
pub(crate) fn endpoint_models_of(value: Option<&Json>) -> Result<Vec<String>, String> {
    let malformed = || "malformed listEndpointModels result: models".to_string();
    value
        .filter(|v| v.is_object())
        .and_then(|v| v.get("models"))
        .and_then(Json::as_array)
        .ok_or_else(malformed)?
        .iter()
        .map(|model| model.as_str().map(|s| s.to_string_lossy()).ok_or_else(malformed))
        .collect()
}
