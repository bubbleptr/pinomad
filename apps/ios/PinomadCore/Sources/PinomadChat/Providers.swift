import Foundation
import PinomadCore

// Settings → Providers (ADR-0031), the parts that aren't layout: wording
// derived from what the host sends, the home page's groups, the custom
// endpoint form's checks, and the login panel's lifecycle. The web client's
// providers-section.tsx, provider-login.tsx and custom-endpoint-form.tsx are
// the reference.

extension ProviderOAuth {
    /// What the user signs in with — the plan, not the provider. pi names
    /// its OAuth methods "Anthropic (Claude Pro/Max)" or "Meta (Muse
    /// subscription)": the parenthesized part without a trailing
    /// "subscription", else the whole name.
    public var plan: String {
        guard let open = name.firstIndex(of: "("), name.hasSuffix(")") else { return name }
        let outer = name[..<open].trimmingCharacters(in: .whitespaces)
        var inner = name[name.index(after: open)..<name.index(before: name.endIndex)]
            .trimmingCharacters(in: .whitespaces)
        if inner.lowercased().hasSuffix("subscription") {
            inner = String(inner.dropLast("subscription".count)).trimmingCharacters(in: .whitespaces)
        }
        return inner.isEmpty ? outer : inner
    }
}

extension ProviderInfo {
    /// Something lets the host reach this provider: a stored credential, the
    /// host's environment, or the endpoint's own entry.
    public var isConnected: Bool { stored != nil || ambient != nil || custom != nil }

    /// Offers a key login among the built-in providers; custom endpoints
    /// take their key in their own form.
    public var takesKey: Bool { apiKey != nil && custom == nil }

    /// A subscription's caption beside the provider's name, where repeating
    /// the name (GitHub Copilot) says nothing.
    public var planCaption: String {
        guard let oauth else { return "Subscription" }
        return oauth.plan == name ? "Subscription" : oauth.plan
    }

    /// The one line under a connected provider's name. The host sends no
    /// account or key details, so none are shown.
    public var credentialLine: String {
        if let custom {
            let count = custom.models.count
            return "\(count) model\(count == 1 ? "" : "s") · \(custom.baseUrl)"
        }
        guard let stored else { return "From the host's environment · \(ambient ?? "")" }
        if stored.kind == .apiKey { return "API key" }
        if stored.subscription, let oauth { return "\(oauth.plan) subscription" }
        return "Signed in"
    }

    /// The caption while logging in by `method`.
    public func methodLabel(_ method: LoginMethod) -> String {
        switch method {
        case .apiKey: return "API key"
        case .oauth: return oauth?.subscription == true ? planCaption : "Account sign-in"
        }
    }

    /// The method a provider page opens on when nothing is connected yet.
    public var defaultMethod: LoginMethod {
        oauth?.subscription == true || apiKey == nil ? .oauth : .apiKey
    }

    /// The OAuth start button's label.
    public var signInLabel: String {
        guard let oauth else { return "Sign in" }
        return oauth.loginLabel ?? "Sign in with \(oauth.plan)"
    }

    /// Above the sign-in button before an OAuth login starts.
    public var oauthIntro: String {
        guard let oauth, oauth.subscription else { return "Sign in to your account; there's no key to copy." }
        return "Use your \(oauth.plan) plan. Requests count against the plan, not per-token billing."
    }

    /// The switch from one credential kind to OAuth.
    public var useOAuthLabel: String {
        guard let oauth, oauth.subscription else { return "Sign in to your account instead" }
        return "Use \(oauth.plan) instead"
    }

    /// What a login by `method` does to what's already configured; nil when
    /// nothing is.
    public func replaceNote(_ method: LoginMethod) -> String? {
        guard let stored else {
            guard let ambient else { return nil }
            return "\(ambient) is set in the host's environment. A credential saved here takes precedence over it."
        }
        let what = stored.kind == .apiKey ? "the stored API key" : "the stored sign-in"
        return stored.kind == method ? "Replaces \(what)." : "Replaces \(what); a provider keeps one credential."
    }
}

/// The Providers home page: what's connected, then the three ways to add one.
public struct ProvidersHome: Equatable, Sendable {
    public let connected: [ProviderInfo]
    /// The first few subscriptions, for the path card's logos.
    public let subscriptions: [ProviderInfo]
    /// Every built-in provider that takes a key.
    public let keyed: [ProviderInfo]
    /// The API key card's logos: a few well-known keyed providers.
    public let keyLogos: [ProviderInfo]

    public init(_ providers: [ProviderInfo]) {
        connected = providers.filter(\.isConnected)
        subscriptions = Array(providers.filter { $0.oauth?.subscription == true }.prefix(5))
        let keyed = providers.filter(\.takesKey)
        self.keyed = keyed
        let featured = ["google", "deepseek", "mistral", "groq", "openrouter"].compactMap { id in
            keyed.first { $0.id == id }
        }
        keyLogos = featured.isEmpty ? Array(keyed.prefix(5)) : featured
    }

    /// The subscription card's foot: each plan's first word, once.
    public var subscriptionFoot: String {
        var seen: [String] = []
        for provider in subscriptions {
            guard let plan = provider.oauth?.plan,
                  let first = plan.split(whereSeparator: { $0 == " " || $0 == "/" }).first.map(String.init),
                  !seen.contains(first)
            else { continue }
            seen.append(first)
        }
        return seen.joined(separator: ", ")
    }
}

/// The subscription page's providers: plans first, then account sign-ins
/// (OpenRouter, Radius), which bill per token.
public func subscriptionProviders(_ providers: [ProviderInfo]) -> [ProviderInfo] {
    let withOAuth = providers.filter { $0.oauth != nil }
    return withOAuth.filter { $0.oauth?.subscription == true } + withOAuth.filter { $0.oauth?.subscription != true }
}

/// The API key page's providers matching a filter on name or id.
public func keyProviders(_ providers: [ProviderInfo], matching query: String) -> [ProviderInfo] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return providers.filter { $0.takesKey && (q.isEmpty || "\($0.name) \($0.id)".lowercased().contains(q)) }
}

// MARK: - Logins

/// The flow's events worth drawing, with their index as a stable id. Only
/// the latest sign-in page and device code count — a retry supersedes the
/// earlier one — and progress notes show as the waiting status instead.
public func shownLoginEvents(_ events: [LoginEvent]) -> [(index: Int, event: LoginEvent)] {
    let lastAuthUrl = events.lastIndex { if case .authUrl = $0 { true } else { false } }
    let lastDeviceCode = events.lastIndex { if case .deviceCode = $0 { true } else { false } }
    return events.enumerated().compactMap { index, event in
        switch event {
        case .info: (index, event)
        case .authUrl: index == lastAuthUrl ? (index, event) : nil
        case .deviceCode: index == lastDeviceCode ? (index, event) : nil
        case .progress: nil
        }
    }
}

/// What a running login without a prompt is doing: approving a device
/// code, or pi's latest progress note.
public func loginWaitingLabel(_ events: [LoginEvent]) -> String {
    for event in events.reversed() {
        switch event {
        case .progress(let message): return message
        case .deviceCode: return "Waiting for you to approve…"
        default: continue
        }
    }
    return "Working…"
}

extension LoginPrompt {
    /// pi phrases prompts as questions ending in ":"; a field label reads
    /// better without it.
    public var label: String {
        var text = message
        while text.last?.isWhitespace == true { text.removeLast() }
        if text.hasSuffix(":") { text.removeLast() }
        return text
    }

    /// Text prompts may be answered empty — pi uses that for "blank for the
    /// default" — secrets, pasted codes and choices may not.
    public func canSubmit(_ value: String) -> Bool {
        if case .text = input { return true }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What goes to the host: text verbatim, the rest trimmed.
    public func answer(_ value: String) -> String {
        if case .text = input { return value }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// How a login the panel follows ended, as far as the page cares.
public enum LoginOutcome: Equatable, Sendable {
    /// Saved: back to the Providers list, where it now shows as connected.
    case succeeded
    /// Cancelled (here or elsewhere), or the host dropped the flow: back to
    /// where the login was opened from.
    case left
}

/// One login panel's hold on its flow. The panel starts a login, follows
/// it in the `providers` stream, and cancels it when the panel goes away
/// while it still runs — leaving the page abandons the login.
///
/// A start that resolves after the panel left (a quick Back) is cancelled
/// on arrival; a flow that was listed and then vanished has ended — the
/// host drops ended flows after a while, and a reconnect can skip the end.
/// A start that failed, though the host began the login before the
/// connection dropped, takes over the provider's running flow from the
/// stream — otherwise a retry is refused and Cancel has nothing to cancel.
public struct LoginTracker: Equatable, Sendable {
    /// The flow this panel follows, once started.
    public private(set) var loginId: String?
    /// Which start is current; a stale resolve is cancelled.
    private var generation = 0
    /// The flow to cancel if the panel goes away: set once begun, cleared
    /// once it ends or the user cancels.
    private var running: String?
    /// Whether `loginId` has been seen in the stream yet.
    private var seen = false
    /// The outcome was reported; later snapshots repeat it.
    private var reported = false
    /// What the last start asked for, until the page leaves: a flow the host
    /// began for it is this page's even when the start's answer was lost.
    private var target: Target?
    /// A start call is in flight; its answer may still name the flow.
    private var pending = false

    private struct Target: Equatable, Sendable {
        let provider: String
        let method: LoginMethod
    }

    public init() {}

    public var hasStarted: Bool { generation > 0 }

    /// Starting (again). The token names this start to `started`/`failed`.
    public mutating func begin(provider: String, method: LoginMethod) -> Int {
        generation += 1
        target = Target(provider: provider, method: method)
        pending = true
        // A retry follows its own flow, not the one that failed.
        loginId = nil
        return generation
    }

    /// The host started the flow. False means the start is stale (the panel
    /// left, or a newer start replaced it): the caller cancels `id`.
    public mutating func started(_ id: String, token: Int) -> Bool {
        guard token == generation else { return false }
        pending = false
        follow(id, listed: false)
        return true
    }

    /// The start failed; false means it is stale. The connection may have
    /// dropped after the host began the login, so a running flow for the
    /// same provider and method in `logins` is adopted as this page's.
    public mutating func failed(_ token: Int, logins: [LoginFlow]) -> Bool {
        guard token == generation else { return false }
        pending = false
        adopt(logins)
        return true
    }

    /// The panel went away: the running flow to cancel, if any. Any start
    /// still in flight becomes stale.
    public mutating func leave() -> String? {
        generation += 1
        target = nil
        pending = false
        defer { running = nil }
        return running
    }

    /// The user pressed Cancel: the flow to cancel, or nil to just go back.
    public mutating func cancel() -> String? {
        defer { running = nil }
        return running
    }

    /// The cancel call failed; the flow still runs and stays ours.
    public mutating func cancelFailed(_ id: String) {
        running = id
    }

    public func flow(in logins: [LoginFlow]) -> LoginFlow? {
        guard let loginId else { return nil }
        return logins.first { $0.id == loginId }
    }

    /// Follow a new `providers.logins`; an outcome is reported once.
    public mutating func observe(_ logins: [LoginFlow]) -> LoginOutcome? {
        adopt(logins)
        guard let loginId, !reported else { return nil }
        guard let flow = logins.first(where: { $0.id == loginId }) else {
            guard seen else { return nil }
            running = nil
            reported = true
            return .left
        }
        seen = true
        switch flow.state {
        case .running:
            return nil
        case .failed:
            // Stays on the page with the error and a retry.
            running = nil
            return nil
        case .succeeded:
            running = nil
            reported = true
            return .succeeded
        case .cancelled:
            running = nil
            reported = true
            return .left
        }
    }

    /// Take over the flow a failed start began, once no start can still name it.
    private mutating func adopt(_ logins: [LoginFlow]) {
        guard loginId == nil, !pending, let target,
              let orphan = logins.first(where: {
                  $0.providerId == target.provider && $0.method == target.method && $0.state == .running
              })
        else { return }
        follow(orphan.id, listed: true)
    }

    private mutating func follow(_ id: String, listed: Bool) {
        loginId = id
        running = id
        seen = listed
        reported = false
    }
}

// MARK: - Custom endpoints

extension CustomProviderApi {
    public static let all: [CustomProviderApi] = [
        .openaiCompletions, .openaiResponses, .anthropicMessages, .googleGenerativeAi,
    ]

    public var label: String {
        switch self {
        case .openaiCompletions: "OpenAI Chat Completions"
        case .openaiResponses: "OpenAI Responses"
        case .anthropicMessages: "Anthropic Messages"
        case .googleGenerativeAi: "Google Gemini"
        }
    }
}

/// "Fetch from /models" as the form stood when it asked. The answer is for
/// that endpoint: dropped once the format, URL or key changed, and it
/// doesn't replace models edited by hand while it was on its way.
public struct EndpointModelsFetch: Equatable, Sendable {
    public var api: CustomProviderApi
    public var baseUrl: String
    public var apiKey: String
    public var models: String

    public init(api: CustomProviderApi, baseUrl: String, apiKey: String, models: String) {
        self.api = api
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.models = models
    }

    /// Whether the answer still speaks for `form`; a stale one is dropped,
    /// its problem included.
    public func answers(_ form: EndpointModelsFetch) -> Bool {
        api == form.api && baseUrl == form.baseUrl && apiKey == form.apiKey
    }

    /// Whether listed models replace `form`'s.
    public func fills(_ form: EndpointModelsFetch) -> Bool {
        answers(form) && models == form.models
    }
}

/// A new endpoint's id: its name in lowercase letters, digits and `-`.
public func customEndpointId(_ name: String) -> String {
    let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
    var id = ""
    var pendingDash = false
    for scalar in folded.unicodeScalars {
        if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
            if pendingDash && !id.isEmpty { id.append("-") }
            pendingDash = false
            id.unicodeScalars.append(scalar)
        } else {
            pendingDash = true
        }
    }
    return id
}

/// Why a base URL can't be saved, or nil.
public func baseUrlProblem(_ text: String) -> String? {
    let url = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if url.isEmpty { return "Enter the base URL" }
    guard let parsed = URLComponents(string: url), let scheme = parsed.scheme, parsed.host?.isEmpty == false else {
        return "Enter a full URL, like http://localhost:11434/v1"
    }
    if scheme != "http" && scheme != "https" { return "Use an http:// or https:// URL" }
    return nil
}

/// One model id per non-blank line.
public func endpointModels(_ text: String) -> [String] {
    text.split(whereSeparator: \.isNewline)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
}

/// Why a name can't be saved, or nil. Editing keeps the endpoint's id, so
/// only a new endpoint's name must make a fresh, free id. An empty name is
/// only a problem once the user tried to save.
public func customEndpointNameProblem(
    _ name: String, editing: Bool, providers: [ProviderInfo], submitted: Bool
) -> String? {
    if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return submitted ? "Name it so it's recognizable in the model picker" : nil
    }
    if editing { return nil }
    let id = customEndpointId(name)
    if id.isEmpty { return "Use at least one letter or digit (a–z, 0–9) in the name" }
    if providers.contains(where: { $0.id == id }) {
        return "“\(id)” is already a provider on this host; choose another name"
    }
    return nil
}

// MARK: - Logos

/// Provider id → logo asset, first match wins; an entry also covers its
/// regional or plan variants (`zai-coding-cn`, `xiaomi-token-plan-sgp`).
/// Mirrors the web's provider-logo.tsx; the assets are lobehub's SVGs
/// (docs/licenses/lobehub-icons.md), exported by scripts/provider-logos.sh.
private let logoOf: [(id: String, logo: String)] = [
    ("anthropic", "anthropic"),
    ("openai-codex", "codex-color"),
    ("openai", "openai"),
    ("github-copilot", "githubcopilot"),
    ("xai", "xai"),
    ("kimi-coding", "kimi-color"),
    ("meta", "meta-color"),
    ("openrouter", "openrouter"),
    ("google-vertex", "vertexai-color"),
    ("google", "gemini-color"),
    ("amazon-bedrock", "bedrock-color"),
    ("azure", "azure-color"),
    ("deepseek", "deepseek-color"),
    ("mistral", "mistral-color"),
    ("groq", "groq"),
    ("cerebras", "cerebras-color"),
    ("together", "together-color"),
    ("fireworks", "fireworks-color"),
    ("baseten", "baseten"),
    ("huggingface", "huggingface-color"),
    ("nvidia", "nvidia-color"),
    ("vercel-ai-gateway", "vercel"),
    ("cloudflare", "cloudflare-color"),
    ("zai", "zai"),
    ("moonshotai", "moonshot"),
    ("minimax", "minimax-color"),
    ("qwen-token-plan", "qwen-color"),
    ("xiaomi", "xiaomimimo"),
    ("ant-ling", "ling-color"),
    ("opencode", "opencode"),
    ("ollama", "ollama"),
    ("lmstudio", "lmstudio"),
]

/// Ollama's default port is the one tell a custom endpoint gives about
/// what serves it.
private let ollamaPort = 11434

/// The asset catalog name of a provider's logo, or nil for initials. A
/// custom endpoint passes its `baseUrl` and gets Ollama's logo on Ollama's
/// port, else none.
public func providerLogoAsset(id: String, baseUrl: String? = nil) -> String? {
    if let baseUrl {
        return URLComponents(string: baseUrl)?.port == ollamaPort ? "provider-ollama" : nil
    }
    return logoOf.first { id == $0.id || id.hasPrefix("\($0.id)-") }.map { "provider-\($0.logo)" }
}

/// Up to two initials for a provider without a logo.
public func providerInitials(_ name: String) -> String {
    name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map { $0.uppercased() }.joined()
}
