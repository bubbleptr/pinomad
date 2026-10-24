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

private func flow(_ id: String, _ state: LoginState) -> LoginFlow {
    LoginFlow(id: id, providerId: "groq", method: .apiKey, events: [], prompt: nil, state: state, error: nil)
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

@Suite struct LoginTrackerTests {
    @Test func successEndsTheLoginOnce() {
        var tracker = LoginTracker()
        let token = tracker.begin()
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
        let token = tracker.begin()
        _ = tracker.started("l1", token: token)
        _ = tracker.observe([flow("l1", .running)])
        let r6 = tracker.leave()
        #expect(r6 == "l1")
    }

    /// A Back before the host answered: the late start is cancelled on arrival.
    @Test func aStartResolvingAfterLeavingIsStale() {
        var tracker = LoginTracker()
        let token = tracker.begin()
        let r7 = tracker.leave()
        #expect(r7 == nil)
        let r8 = tracker.started("l1", token: token)
        #expect(!r8)
        #expect(!tracker.isCurrent(token))
    }

    /// The host drops ended flows; one that was listed and vanished has ended.
    @Test func aDroppedFlowLeavesThePage() {
        var tracker = LoginTracker()
        let token = tracker.begin()
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
        _ = tracker.started("l1", token: tracker.begin())
        let r13 = tracker.observe([flow("l1", .failed)])
        #expect(r13 == nil)
        let r14 = tracker.leave()
        #expect(r14 == nil)

        var retry = LoginTracker()
        _ = retry.started("l1", token: retry.begin())
        _ = retry.observe([flow("l1", .failed)])
        let token = retry.begin()
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
        _ = tracker.started("l1", token: tracker.begin())
        let r18 = tracker.cancel()
        #expect(r18 == "l1")
        let r19 = tracker.leave()
        #expect(r19 == nil)
        tracker.cancelFailed("l1")
        let r20 = tracker.leave()
        #expect(r20 == "l1")
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
