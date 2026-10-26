import PinomadCore
import Testing
@testable import PinomadChat

private func provider(
    _ id: String, name: String? = nil, oauth: ProviderOAuth? = nil, apiKey: String? = nil,
    stored: StoredCredential? = nil, ambient: String? = nil, custom: CustomProvider? = nil
) -> ProviderInfo {
    ProviderInfo(id: id, name: name ?? id, oauth: oauth, apiKey: apiKey, stored: stored, ambient: ambient, custom: custom)
}

private func plan(_ name: String, subscription: Bool = true) -> ProviderOAuth {
    ProviderOAuth(name: name, subscription: subscription, loginLabel: nil)
}

private func flow(
    _ id: String, _ state: LoginState, provider: String = "groq", method: LoginMethod = .apiKey
) -> LoginFlow {
    LoginFlow(id: id, providerId: provider, method: method, events: [], prompt: nil, state: state, error: nil)
}

@Suite struct ProviderWordingTests {
    /// pi names a plan inside parentheses; the plan is what the user knows.
    @Test func planIsTheParenthesizedPartWithoutSubscription() {
        #expect(plan("Anthropic (Claude Pro/Max)").plan == "Claude Pro/Max")
        #expect(plan("Meta (Muse subscription)").plan == "Muse")
        #expect(plan("Acme (subscription)").plan == "Acme")
        #expect(plan("GitHub Copilot").plan == "GitHub Copilot")
    }

    @Test func credentialLineSaysWhereAuthComesFrom() {
        let claude = plan("Anthropic (Claude Pro/Max)")
        #expect(provider("a", oauth: claude, stored: StoredCredential(kind: .oauth, subscription: true)).credentialLine
            == "Claude Pro/Max subscription")
        #expect(provider("o", oauth: plan("OpenRouter", subscription: false), stored: StoredCredential(kind: .oauth, subscription: false))
            .credentialLine == "Signed in")
        #expect(provider("g", stored: StoredCredential(kind: .apiKey, subscription: false), ambient: "GROQ_API_KEY").credentialLine
            == "API key")
        #expect(provider("g", ambient: "GEMINI_API_KEY").credentialLine == "From the host's environment · GEMINI_API_KEY")
        let one = CustomProvider(api: .openaiCompletions, baseUrl: "http://studio:11434/v1", models: ["llama3"])
        #expect(provider("c", custom: one).credentialLine == "1 model · http://studio:11434/v1")
    }

    /// Saving over an environment variable or another credential says so.
    @Test func replaceNoteNamesWhatALoginReplaces() {
        #expect(provider("g").replaceNote(.apiKey) == nil)
        #expect(provider("g", ambient: "GEMINI_API_KEY").replaceNote(.apiKey)
            == "GEMINI_API_KEY is set in the host's environment. A credential saved here takes precedence over it.")
        let keyed = provider("a", stored: StoredCredential(kind: .apiKey, subscription: false))
        #expect(keyed.replaceNote(.apiKey) == "Replaces the stored API key.")
        #expect(keyed.replaceNote(.oauth) == "Replaces the stored API key; a provider keeps one credential.")
    }

    @Test func subscriptionCaptionSkipsARepeatedName() {
        #expect(provider("github-copilot", name: "GitHub Copilot", oauth: plan("GitHub Copilot")).planCaption == "Subscription")
        #expect(provider("anthropic", name: "Anthropic", oauth: plan("Anthropic (Claude Pro/Max)")).planCaption == "Claude Pro/Max")
    }
}

@Suite struct ProvidersHomeTests {
    @Test func groupsConnectedSubscriptionsAndKeys() {
        let providers = [
            provider("anthropic", oauth: plan("Anthropic (Claude Pro/Max)"), apiKey: "Anthropic"),
            provider("openai-codex", oauth: plan("ChatGPT Plus/Pro (Codex Subscription)")),
            provider("openrouter", oauth: plan("OpenRouter", subscription: false), apiKey: "OpenRouter"),
            provider("google", apiKey: "Google", ambient: "GEMINI_API_KEY"),
            provider("groq", apiKey: "Groq", stored: StoredCredential(kind: .apiKey, subscription: false)),
            provider("studio", apiKey: "Studio", custom: CustomProvider(api: .openaiCompletions, baseUrl: "http://s/v1", models: [])),
        ]
        let home = ProvidersHome(providers)
        #expect(home.connected.map(\.id) == ["google", "groq", "studio"])
        #expect(home.subscriptions.map(\.id) == ["anthropic", "openai-codex"])
        // Custom endpoints take their key in their own form.
        #expect(home.keyed.map(\.id) == ["anthropic", "openrouter", "google", "groq"])
        #expect(home.keyLogos.map(\.id) == ["google", "groq", "openrouter"])
        #expect(home.subscriptionFoot == "Claude, Codex")
    }

    /// Plans first; account sign-ins bill per token.
    @Test func subscriptionPageListsPlansBeforeAccountSignIns() {
        let providers = [
            provider("openrouter", oauth: plan("OpenRouter", subscription: false)),
            provider("anthropic", oauth: plan("Anthropic (Claude Pro/Max)")),
            provider("groq", apiKey: "Groq"),
        ]
        #expect(subscriptionProviders(providers).map(\.id) == ["anthropic", "openrouter"])
    }

    @Test func keyFilterMatchesNameOrId() {
        let providers = [provider("moonshotai", name: "Moonshot AI", apiKey: "k"), provider("groq", name: "Groq", apiKey: "k")]
        #expect(keyProviders(providers, matching: " moon ").map(\.id) == ["moonshotai"])
        #expect(keyProviders(providers, matching: "GROQ").map(\.id) == ["groq"])
        #expect(keyProviders(providers, matching: "").count == 2)
    }
}

@Suite struct LoginViewTests {
    /// A retry supersedes the earlier sign-in page and device code; progress
    /// shows as the waiting status, not as an event.
    @Test func onlyTheLatestAuthUrlAndDeviceCodeShow() {
        let events: [LoginEvent] = [
            .authUrl(url: "https://a/1", instructions: nil),
            .info(message: "Note", links: []),
            .deviceCode(userCode: "OLD", verificationUri: "https://d", expiresAt: nil),
            .progress(message: "Polling"),
            .authUrl(url: "https://a/2", instructions: nil),
            .deviceCode(userCode: "NEW", verificationUri: "https://d", expiresAt: nil),
        ]
        #expect(shownLoginEvents(events).map(\.index) == [1, 4, 5])
    }

    @Test func waitingLabelFollowsTheLatestProgressOrDeviceCode() {
        #expect(loginWaitingLabel([]) == "Working…")
        #expect(loginWaitingLabel([.progress(message: "Exchanging code")]) == "Exchanging code")
        #expect(loginWaitingLabel([.progress(message: "a"), .deviceCode(userCode: "X", verificationUri: "u", expiresAt: nil)])
            == "Waiting for you to approve…")
    }

    /// Text may be blank ("blank for the default"); secrets, codes and
    /// choices need a value.
    @Test func onlyTextPromptsAcceptAnEmptyAnswer() {
        let text = LoginPrompt(id: 1, message: "Base URL (blank for default):", input: .text(placeholder: nil))
        let secret = LoginPrompt(id: 2, message: "API key:", input: .secret(placeholder: nil))
        #expect(text.canSubmit(""))
        #expect(!secret.canSubmit("  "))
        #expect(secret.answer(" sk-1 \n") == "sk-1")
        #expect(text.answer(" keep ") == " keep ")
        #expect(secret.label == "API key")
    }
}

/// Every Providers page is opened for one host (#343 review): another
/// host's providers never show on it, so nothing on it reaches that host.
@Suite struct ProvidersPageTests {
    private let groq = HostProviders(providers: [provider("groq")], logins: [])

    @Test func aPageForAnotherHostShowsNoProviders() {
        #expect(providersPage(openedFor: "a", currentHost: "b", hasSnapshot: true, providers: groq, supportsLogins: true)
            == .otherHost)
        #expect(providersPage(openedFor: "a", currentHost: nil, hasSnapshot: false, providers: nil, supportsLogins: false)
            == .otherHost)
        // The right host, but its session isn't up yet.
        #expect(providersPage(openedFor: "a", currentHost: "a", hasSnapshot: false, providers: nil, supportsLogins: false)
            == .otherHost)
    }

    @Test func thePagesOwnHostShowsItsProviders() {
        #expect(providersPage(openedFor: "a", currentHost: "a", hasSnapshot: true, providers: groq, supportsLogins: true)
            == .ready(groq))
    }

    /// A 5.21 host sends the stream right after connecting; an older one never will.
    @Test func noStreamYetIsLoadingOrAnUpgrade() {
        #expect(providersPage(openedFor: "a", currentHost: "a", hasSnapshot: true, providers: nil, supportsLogins: true)
            == .loading)
        #expect(providersPage(openedFor: "a", currentHost: "a", hasSnapshot: true, providers: nil, supportsLogins: false)
            == .needsUpgrade)
    }
}

@Suite struct LoginTrackerTests {
    @Test func successEndsTheLoginOnce() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        let r1 = tracker.started("l1", token: token)
        #expect(r1)
        let r2 = tracker.observe([flow("l1", .running)])
        #expect(r2 == nil)
        let r3 = tracker.observe([flow("l1", .succeeded)])
        #expect(r3 == .succeeded)
        let r4 = tracker.observe([flow("l1", .succeeded)])
        #expect(r4 == nil)
        // Nothing left to cancel when the page then goes away.
        let r5 = tracker.leave()
        #expect(r5 == nil)
    }

    /// Leaving the page abandons the login it started.
    @Test func leavingCancelsARunningLogin() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        _ = tracker.started("l1", token: token)
        _ = tracker.observe([flow("l1", .running)])
        let r6 = tracker.leave()
        #expect(r6 == "l1")
    }

    /// A Back before the host answered: the late start is cancelled on arrival.
    @Test func aStartResolvingAfterLeavingIsStale() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        let r7 = tracker.leave()
        #expect(r7 == nil)
        let r8 = tracker.started("l1", token: token)
        #expect(!r8)
        let stale = tracker.failed(token, error: SessionError.connectionLost, logins: [])
        #expect(!stale)
    }

    /// The host drops ended flows; one that was listed and vanished has ended.
    @Test func aDroppedFlowLeavesThePage() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        _ = tracker.started("l1", token: token)
        // Not listed yet: the start answered before the stream caught up.
        let r9 = tracker.observe([])
        #expect(r9 == nil)
        let r10 = tracker.observe([flow("l1", .running)])
        #expect(r10 == nil)
        let r11 = tracker.observe([])
        #expect(r11 == .left)
        let r12 = tracker.leave()
        #expect(r12 == nil)
    }

    /// A failure stays on the page; a retry follows the new flow from scratch.
    @Test func aRetryAfterFailureFollowsTheNewFlow() {
        var tracker = LoginTracker()
        _ = tracker.started("l1", token: tracker.begin(provider: "groq", method: .apiKey))
        let r13 = tracker.observe([flow("l1", .failed)])
        #expect(r13 == nil)
        let r14 = tracker.leave()
        #expect(r14 == nil)

        var retry = LoginTracker()
        _ = retry.started("l1", token: retry.begin(provider: "groq", method: .apiKey))
        _ = retry.observe([flow("l1", .failed)])
        let token = retry.begin(provider: "groq", method: .apiKey)
        let r15 = retry.started("l2", token: token)
        #expect(r15)
        // The old flow was seen, the new one not yet: that's no drop.
        let r16 = retry.observe([flow("l1", .failed)])
        #expect(r16 == nil)
        let r17 = retry.observe([flow("l2", .cancelled)])
        #expect(r17 == .left)
    }

    @Test func aFailedCancelKeepsTheLoginOurs() {
        var tracker = LoginTracker()
        _ = tracker.started("l1", token: tracker.begin(provider: "groq", method: .apiKey))
        let r18 = tracker.cancel()
        #expect(r18 == "l1")
        let r19 = tracker.leave()
        #expect(r19 == nil)
        tracker.cancelFailed("l1")
        let r20 = tracker.leave()
        #expect(r20 == "l1")
    }

    /// The connection dropped after the host began the login but before its
    /// id came back: the flow it began is this page's, prompts and all.
    @Test func aStartLostToADisconnectAdoptsTheHostsFlow() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        // The reconnect's snapshot can land before the start fails: the start may still answer.
        let r21 = tracker.observe([flow("l1", .running)])
        #expect(r21 == nil)
        #expect(tracker.loginId == nil)
        let r22 = tracker.failed(token, error: SessionError.connectionLost, logins: [flow("l1", .running)])
        #expect(r22)
        #expect(tracker.loginId == "l1")
        // Ours now: leaving cancels it.
        let r23 = tracker.leave()
        #expect(r23 == "l1")
    }

    @Test func aLostStartAdoptsAFlowListedAfterTheFailure() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        _ = tracker.failed(token, error: SessionError.connectionLost, logins: [])
        #expect(tracker.loginId == nil)
        // Another provider's, another method's, or an ended flow is not it.
        let r24 = tracker.observe([
            flow("l0", .running, provider: "openai"), flow("l2", .running, method: .oauth), flow("l3", .failed),
        ])
        #expect(r24 == nil)
        #expect(tracker.loginId == nil)
        let r25 = tracker.observe([flow("l1", .running)])
        #expect(r25 == nil)
        #expect(tracker.loginId == "l1")
        let r26 = tracker.observe([])
        #expect(r26 == .left)
    }

    @Test func aRetryLostToADisconnectAdoptsTheNewFlow() {
        var tracker = LoginTracker()
        _ = tracker.started("l1", token: tracker.begin(provider: "groq", method: .apiKey))
        _ = tracker.observe([flow("l1", .failed)])
        let token = tracker.begin(provider: "groq", method: .apiKey)
        let r27 = tracker.failed(
            token, error: SessionError.connectionLost, logins: [flow("l1", .failed), flow("l2", .running)])
        #expect(r27)
        #expect(tracker.loginId == "l2")
    }

    /// The host refusing the start (another device's login is running) is
    /// no lost answer: that login isn't this page's to follow or cancel.
    @Test func aRefusedStartAdoptsNothing() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        let refusal = SessionError.operationFailed("A login for Groq is already in progress")
        let r30 = tracker.failed(token, error: refusal, logins: [flow("l1", .running)])
        #expect(r30)
        #expect(tracker.loginId == nil)
        let r31 = tracker.observe([flow("l1", .running)])
        #expect(r31 == nil)
        #expect(tracker.loginId == nil)
        let r32 = tracker.leave()
        #expect(r32 == nil)
    }

    /// A page that left adopts nothing: no one would be there to cancel it.
    @Test func aLeftPageAdoptsNothing() {
        var tracker = LoginTracker()
        let token = tracker.begin(provider: "groq", method: .apiKey)
        _ = tracker.leave()
        let r28 = tracker.failed(token, error: SessionError.connectionLost, logins: [flow("l1", .running)])
        #expect(!r28)
        let r29 = tracker.observe([flow("l1", .running)])
        #expect(r29 == nil)
        #expect(tracker.loginId == nil)
    }
}

@Suite struct CustomEndpointFormTests {
    @Test func idIsTheNameInLowercaseLettersDigitsAndDashes() {
        #expect(customEndpointId("Ollama on studio") == "ollama-on-studio")
        #expect(customEndpointId("  Café — GPU #2 ") == "cafe-gpu-2")
        #expect(customEndpointId("日本") == "")
    }

    @Test func nameProblems() {
        let providers = [provider("groq")]
        #expect(customEndpointNameProblem("", editing: false, providers: providers, submitted: false) == nil)
        #expect(customEndpointNameProblem("", editing: false, providers: providers, submitted: true)
            == "Name it so it's recognizable in the model picker")
        #expect(customEndpointNameProblem("Groq", editing: false, providers: providers, submitted: false)
            == "“groq” is already a provider on this host; choose another name")
        // Editing keeps the endpoint's own id.
        #expect(customEndpointNameProblem("Groq", editing: true, providers: providers, submitted: false) == nil)
        #expect(customEndpointNameProblem("日本", editing: false, providers: providers, submitted: false)
            == "Use at least one letter or digit (a–z, 0–9) in the name")
    }

    @Test func baseUrlMustBeAFullHttpUrl() {
        #expect(baseUrlProblem(" ") == "Enter the base URL")
        #expect(baseUrlProblem("localhost:11434") != nil)
        #expect(baseUrlProblem("ftp://host/v1") == "Use an http:// or https:// URL")
        #expect(baseUrlProblem(" http://localhost:11434/v1 ") == nil)
    }

    /// An answer is for the endpoint as asked about (#343 review).
    @Test func aModelsAnswerForAnotherEndpointIsDropped() {
        let asked = EndpointModelsFetch(api: .openaiCompletions, baseUrl: "http://a.local/v1", apiKey: "", models: "")
        var now = asked
        #expect(asked.answers(now) && asked.fills(now))
        now.baseUrl = "http://b.local/v1"
        #expect(!asked.answers(now))
        now = asked
        now.api = .anthropicMessages
        #expect(!asked.answers(now))
        now = asked
        now.apiKey = "sk-other"
        #expect(!asked.answers(now))
    }

    @Test func aModelsAnswerKeepsModelsTypedMeanwhile() {
        let asked = EndpointModelsFetch(api: .openaiCompletions, baseUrl: "http://a.local/v1", apiKey: "", models: "")
        var now = asked
        now.models = "my-model"
        #expect(asked.answers(now))
        #expect(!asked.fills(now))
    }

    @Test func modelsAreTheNonBlankLines() {
        #expect(endpointModels(" llama3 \n\n qwen3\r\n") == ["llama3", "qwen3"])
    }
}

@Suite struct ProviderLogoTests {
    @Test func variantsShareTheirProvidersLogo() {
        #expect(providerLogoAsset(id: "openai-codex") == "provider-codex-color")
        #expect(providerLogoAsset(id: "openai") == "provider-openai")
        #expect(providerLogoAsset(id: "zai-coding-cn") == "provider-zai")
        #expect(providerLogoAsset(id: "radius") == nil)
    }

    /// A custom endpoint is only recognizable by Ollama's port.
    @Test func customEndpointsGetOllamasLogoOnItsPort() {
        #expect(providerLogoAsset(id: "openai", baseUrl: "http://studio:11434/v1") == "provider-ollama")
        #expect(providerLogoAsset(id: "openai", baseUrl: "http://studio:1234/v1") == nil)
    }

    @Test func initialsTakeTwoWords() {
        #expect(providerInitials("Ollama on studio") == "OO")
        #expect(providerInitials("radius") == "R")
    }
}

@Suite struct ModelLogoTests {
    private func logo(_ provider: String, _ modelId: String) -> String? {
        modelLogoAsset(ModelRef(provider: provider, modelId: modelId))
    }

    @Test func namesTheMakerWhoeverServesIt() {
        #expect(logo("github-copilot", "claude-sonnet-4.5") == "provider-claude-color")
        #expect(logo("amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0") == "provider-claude-color")
        #expect(logo("openrouter", "moonshotai/kimi-k2") == "provider-kimi-color")
    }

    @Test func tellsGemmaFromGemini() {
        #expect(logo("google", "gemma-3-27b-it") == "provider-gemma-color")
        #expect(logo("openrouter", "google/gemini-2.5-pro") == "provider-gemini-color")
    }

    /// Short names match the whole token only.
    @Test func readsOSeriesAsOpenAIWithoutCatchingOtherOWords() {
        #expect(logo("github-copilot", "o4-mini") == "provider-openai")
        #expect(logo("openrouter", "openrouter/optimus-alpha") == "provider-openrouter")
    }

    @Test func creditsTheLeftmostMakerInAFineTune() {
        #expect(logo("groq", "deepseek-r1-distill-llama-70b") == "provider-deepseek-color")
        #expect(logo("nvidia", "nvidia/llama-3.1-nemotron-70b-instruct") == "provider-nvidia-color")
    }

    @Test func fallsBackToTheProvidersLogoThenToNone() {
        #expect(logo("kimi-coding", "k3-256k") == "provider-kimi-color")
        #expect(logo("opencode", "big-pickle") == "provider-opencode")
        #expect(logo("custom-lab", "house-model") == nil)
    }
}

@Suite struct ModelSeriesNameTests {
    private func series(_ name: String, _ provider: String, _ modelId: String) -> String {
        modelSeriesName(name, model: ModelRef(provider: provider, modelId: modelId))
    }

    @Test func dropsTheBrandTheLogoAlreadyShows() {
        #expect(series("Claude Opus 4.1", "amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0") == "Opus 4.1")
        #expect(series("MiniMax M2", "minimax", "MiniMax-M2") == "M2")
        #expect(series("Gemini 2.5 Pro", "openrouter", "google/gemini-2.5-pro") == "2.5 Pro")
    }

    /// A series that only starts like a brand, or a family whose maker's
    /// logo is not its own (OpenAI's for GPT, Meta's for Llama), is the
    /// name worth reading.
    @Test func keepsSeriesNamesThatAreNotTheBrandWord() {
        #expect(series("GPT-5.1 Codex", "openai", "gpt-5.1-codex") == "GPT-5.1 Codex")
        #expect(series("Llama 4 Maverick", "groq", "llama-4-maverick") == "Llama 4 Maverick")
        #expect(series("Qwen3 Coder", "openrouter", "qwen/qwen3-coder") == "Qwen3 Coder")
        #expect(series("Devstral Medium", "mistral", "devstral-medium-latest") == "Devstral Medium")
        #expect(series("o4-mini", "github-copilot", "o4-mini") == "o4-mini")
    }

    @Test func keepsTheWholeNameWhenNothingWouldBeLeftOrTheLogoDiffers() {
        #expect(series("Claude", "anthropic", "claude") == "Claude")
        // No logo beside it, so the brand is the only place it is said.
        #expect(series("Claude Distill", "custom-lab", "house-model") == "Claude Distill")
    }
}
