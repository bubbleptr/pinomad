import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

/// One provider: its connection when it has one, or a login by `method`.
/// A provider keeps one credential, so a login of either kind replaces
/// what is stored; a key saved here overrides an environment variable.
///
/// The page owns the login it starts: leaving the page cancels it while it
/// still runs, a flow the host drops goes back, and a saved login returns
/// to the Providers list.
struct ProviderPageView: View {
    let model: AppModel
    let providerId: String
    /// The login the page was opened for; nil opens on the connection.
    let method: LoginMethod?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.popToProviders) private var popToProviders
    @State private var login: LoginMethod?
    @State private var tracker = LoginTracker()
    @State private var opened = false

    private var provider: ProviderInfo? {
        model.providers?.providers.first { $0.id == providerId }
    }

    var body: some View {
        ScrollView {
            if let provider {
                VStack(alignment: .leading, spacing: 20) {
                    header(provider)
                    if let login {
                        VStack(alignment: .leading, spacing: 16) {
                            if let note = provider.replaceNote(login) {
                                Text(note).font(.subheadline).foregroundStyle(.secondary)
                            }
                            LoginPanel(
                                model: model, provider: provider, method: login, tracker: $tracker,
                                onCancel: leaveLogin)
                                .id(login)
                        }
                    } else {
                        ConnectionActions(model: model, provider: provider, onLogin: startLogin) {
                            popToProviders()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !opened, let provider else { return }
            opened = true
            login = method ?? (provider.isConnected ? nil : provider.defaultMethod)
        }
        // On the page root: a row in a lazy container disappears on scroll.
        .onDisappear(perform: abandon)
        .onChange(of: model.providers?.logins, initial: true) { _, logins in
            // A stream not (yet) there is unknown, never "no logins".
            guard let logins else { return }
            switch tracker.observe(logins) {
            case .succeeded: popToProviders()
            case .left: leaveLogin()
            case nil: break
            }
        }
        // Removed elsewhere (another device, a hand edit): nothing left to show.
        .onChange(of: provider == nil) { _, gone in
            if gone && model.providers != nil { dismiss() }
        }
    }

    private func header(_ provider: ProviderInfo) -> some View {
        HStack(spacing: 12) {
            ProviderLogo(id: provider.id, name: provider.name, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name).font(.title3.weight(.semibold))
                Text(login.map(provider.methodLabel) ?? provider.credentialLine)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Another way in from the connection, or "use X instead" mid-login:
    /// whatever ran is abandoned first.
    private func startLogin(_ next: LoginMethod) {
        abandon()
        tracker = LoginTracker()
        login = next
    }

    /// Back from a login: to the connection when the page opened on it,
    /// else to where the login was picked.
    private func leaveLogin() {
        abandon()
        tracker = LoginTracker()
        if method == nil {
            login = nil
        } else {
            dismiss()
        }
    }

    private func abandon() {
        if let id = tracker.leave() { model.abandonLogin(id) }
    }
}

/// A connected provider's actions. Ambient auth lives in the host's
/// environment, so it has no log out here.
private struct ConnectionActions: View {
    let model: AppModel
    let provider: ProviderInfo
    let onLogin: (LoginMethod) -> Void
    let onRemoved: () -> Void

    @State private var confirming = false

    var body: some View {
        let connected = model.connected
        VStack(alignment: .leading, spacing: 12) {
            if let stored = provider.stored {
                if let ambient = provider.ambient {
                    note("\(ambient) is also set where the host runs; the stored credential takes precedence.")
                }
                let isKey = stored.kind == .apiKey
                HStack(spacing: 10) {
                    Button(isKey ? "Replace key" : "Sign in again") { onLogin(stored.kind) }
                        .buttonStyle(.tactile(.borderedProminent))
                    Button(isKey ? "Remove key…" : "Log out…", role: .destructive) { confirming = true }
                        .buttonStyle(.tactile(.bordered))
                }
                if let other = otherMethod(stored.kind) {
                    Button(other == .apiKey ? "Use an API key instead" : provider.useOAuthLabel) { onLogin(other) }
                        .buttonStyle(.borderless)
                }
            } else {
                note("Set as \(provider.ambient ?? "an environment variable") where the host runs. Remove it there, or save a credential here to override it.")
                HStack(spacing: 10) {
                    if provider.apiKey != nil {
                        Button("Save a key here") { onLogin(.apiKey) }
                            .buttonStyle(.tactile(.borderedProminent))
                    }
                    if provider.oauth != nil {
                        Button(provider.useOAuthLabel) { onLogin(.oauth) }
                            .buttonStyle(.tactile(.bordered))
                    }
                }
            }
        }
        .disabled(!connected)
        .confirmationDialog(
            provider.stored?.kind == .apiKey ? "Remove the key?" : "Log out of \(provider.name)?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button(provider.stored?.kind == .apiKey ? "Remove key" : "Log out", role: .destructive) {
                model.logout(provider: provider.id)
                onRemoved()
            }
        } message: {
            Text(provider.stored?.kind == .apiKey
                 ? "Removes the key from this host. Conversations using \(provider.name) models stop until you add another."
                 : "Signs this host out of \(provider.name). Conversations using its models stop until you sign in again.")
        }
    }

    private func otherMethod(_ kind: LoginMethod) -> LoginMethod? {
        switch kind {
        case .apiKey: provider.oauth == nil ? nil : .oauth
        case .oauth: provider.apiKey == nil ? nil : .apiKey
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.subheadline).foregroundStyle(.secondary)
    }
}

/// One login, driven by pi's own events and prompts (ADR-0031): the host
/// pushes the flow in `providers.logins`, this shows its events and current
/// prompt, and each answer goes back by prompt id. OAuth waits for the user
/// to press sign in; an API key login starts on arrival.
private struct LoginPanel: View {
    let model: AppModel
    let provider: ProviderInfo
    let method: LoginMethod
    @Binding var tracker: LoginTracker
    let onCancel: () -> Void

    @State private var starting = false
    @State private var startError: String?
    @State private var cancelError: String?

    var body: some View {
        let connected = model.connected
        let flow = tracker.flow(in: model.providers?.logins ?? [])
        Group {
            if tracker.loginId == nil {
                if method == .apiKey && startError == nil {
                    Status(label: "Starting…")
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        if method == .oauth {
                            Text(provider.oauthIntro)
                        }
                        if let startError {
                            ErrorNote(title: "Couldn't start the login", message: startError)
                        }
                        HStack(spacing: 10) {
                            Button(method == .apiKey ? "Try again" : provider.signInLabel, action: start)
                                .buttonStyle(.tactile(.borderedProminent))
                                .disabled(!connected || starting)
                            Button("Cancel", action: onCancel)
                                .buttonStyle(.tactile(.bordered))
                            if starting { ProgressView() }
                        }
                    }
                }
            } else if let flow {
                switch flow.state {
                case .failed:
                    VStack(alignment: .leading, spacing: 12) {
                        ErrorNote(
                            title: method == .apiKey ? "The key wasn't saved" : "Sign-in failed",
                            message: flow.error ?? "")
                        HStack(spacing: 10) {
                            Button("Try again", action: start)
                                .buttonStyle(.tactile(.borderedProminent))
                                .disabled(!connected || starting)
                            Button("Cancel", action: onCancel)
                                .buttonStyle(.tactile(.bordered))
                        }
                    }
                case .succeeded: Status(label: "Saved")
                case .cancelled: Status(label: "Cancelled")
                case .running: running(flow, connected: connected)
                }
            } else {
                Status(label: "Starting…")
            }
        }
        .onAppear {
            if method == .apiKey && !tracker.hasStarted { start() }
        }
    }

    @ViewBuilder
    private func running(_ flow: LoginFlow, connected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(shownLoginEvents(flow.events), id: \.index) { shown in
                LoginEventView(event: shown.event)
            }
            if let prompt = flow.prompt {
                PromptForm(
                    prompt: prompt, connected: connected, cancelError: cancelError, onCancel: cancel
                ) { value in
                    do {
                        try await model.answerLogin(flow.id, prompt: prompt.id, value: value)
                        return nil
                    } catch {
                        return model.describe(error)
                    }
                }
                .id(prompt.id)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Status(label: loginWaitingLabel(flow.events))
                    HStack(spacing: 10) {
                        Button("Cancel", action: cancel)
                            .buttonStyle(.tactile(.bordered))
                        if let cancelError { InlineError(message: cancelError) }
                    }
                }
            }
        }
    }

    private func start() {
        let token = tracker.begin()
        starting = true
        startError = nil
        Task {
            do {
                let id = try await model.beginLogin(provider: provider.id, method: method)
                if tracker.started(id, token: token) {
                    starting = false
                } else {
                    // The page left (or a newer start won) while this one was in flight.
                    model.abandonLogin(id)
                }
            } catch {
                guard tracker.isCurrent(token) else { return }
                startError = model.describe(error)
                starting = false
            }
        }
    }

    private func cancel() {
        guard let id = tracker.cancel() else { return onCancel() }
        cancelError = nil
        Task {
            do {
                try await model.cancelLogin(id)
                onCancel()
            } catch {
                tracker.cancelFailed(id)
                cancelError = model.describe(error)
            }
        }
    }
}

private struct LoginEventView: View {
    let event: LoginEvent

    @Environment(\.openURL) private var openURL

    var body: some View {
        switch event {
        case .info(let message, let links):
            VStack(alignment: .leading, spacing: 6) {
                Text(message).font(.subheadline).foregroundStyle(.secondary)
                ForEach(links, id: \.url) { link in
                    if let url = URL(string: link.url) {
                        Link(link.label ?? link.url, destination: url).font(.subheadline)
                    }
                }
            }
        case .authUrl(let url, let instructions):
            VStack(alignment: .leading, spacing: 10) {
                Text(instructions ?? "Open the sign-in page and approve access.")
                if let target = URL(string: url) {
                    Button {
                        openURL(target)
                    } label: {
                        Label("Open sign-in page", image: .externalLink)
                    }
                    .buttonStyle(.tactile(.bordered))
                }
            }
        case .deviceCode(let code, let uri, _):
            DeviceCodeSteps(code: code, uri: uri)
        case .progress:
            EmptyView()
        }
    }
}

/// Copy the code, then enter it on the provider's site.
private struct DeviceCodeSteps: View {
    let code: String
    let uri: String

    @Environment(\.openURL) private var openURL
    @State private var copied = false

    var body: some View {
        let url = URL(string: uri)
        let host = url?.host() ?? uri
        let display = url.map { "\($0.host() ?? "")\($0.path() == "/" ? "" : $0.path())" } ?? uri
        VStack(alignment: .leading, spacing: 16) {
            step(1) {
                Text("Copy this code.")
                HStack(spacing: 12) {
                    Text(code)
                        .font(.title2.monospaced().weight(.semibold))
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = code
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy", image: copied ? .check : .copy)
                    }
                    .buttonStyle(.tactile(.bordered))
                    .sensoryFeedback(.success, trigger: copied)
                }
            }
            step(2) {
                Text("Enter it at \(Text(display).monospaced())")
                if let url {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open \(host)", image: .externalLink)
                    }
                    .buttonStyle(.tactile(.bordered))
                }
            }
        }
    }

    private func step(_ number: Int, @ViewBuilder content: () -> some View) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number).").monospacedDigit().foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8, content: content)
        }
    }
}

/// The current prompt as one field. Success keeps the field busy: the host
/// replaces this prompt next.
private struct PromptForm: View {
    let prompt: LoginPrompt
    let connected: Bool
    let cancelError: String?
    let onCancel: () -> Void
    /// Sends the answer; the host's refusal, or nil.
    let onAnswer: (String) async -> String?

    @State private var value = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        let canSubmit = connected && !sending && prompt.canSubmit(value)
        VStack(alignment: .leading, spacing: 12) {
            switch prompt.input {
            case .select(let options):
                Text(prompt.label).font(.subheadline.weight(.medium))
                VStack(spacing: 0) {
                    ForEach(options, id: \.id) { option in
                        Button {
                            value = option.id
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).foregroundStyle(.primary)
                                    if let description = option.description {
                                        Text(description).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if value == option.id { Image(.check).foregroundStyle(.tint) }
                            }
                            .contentShape(.rect)
                            .padding(.vertical, 10)
                            .padding(.horizontal, 14)
                        }
                        .buttonStyle(.plain)
                        if option.id != options.last?.id { Divider().padding(.leading, 14) }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                .onAppear { if value.isEmpty { value = options.first?.id ?? "" } }
            case .secret(let placeholder):
                Text(prompt.label).font(.subheadline.weight(.medium))
                field(SecureField(placeholder ?? "", text: $value))
            case .text(let placeholder), .manualCode(let placeholder):
                Text(prompt.label).font(.subheadline.weight(.medium))
                field(TextField(placeholder ?? "", text: $value))
            }
            if let error { InlineError(message: error) }
            HStack(spacing: 10) {
                Button("Continue", action: submit)
                    .buttonStyle(.tactile(.borderedProminent))
                    .disabled(!canSubmit)
                Button("Cancel", action: onCancel)
                    .buttonStyle(.tactile(.bordered))
                if sending { ProgressView() }
            }
            if let cancelError { InlineError(message: cancelError) }
        }
        .disabled(!connected)
        .onAppear { focused = true }
    }

    private func field(_ input: some View) -> some View {
        input
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($focused)
            .submitLabel(.continue)
            .onSubmit(submit)
            .onChange(of: value) { error = nil }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
    }

    private func submit() {
        guard connected, !sending, prompt.canSubmit(value) else { return }
        sending = true
        error = nil
        let answer = prompt.answer(value)
        Task {
            if let refusal = await onAnswer(answer) {
                error = refusal
                sending = false
            }
        }
    }
}

private struct Status: View {
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ErrorNote: View {
    let title: String
    let message: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                if !message.isEmpty {
                    Text(message).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(.circleAlert).foregroundStyle(.red)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.red.opacity(0.08), in: .rect(cornerRadius: 12))
    }
}

struct InlineError: View {
    let message: String

    var body: some View {
        Text(message).font(.footnote).foregroundStyle(.red)
    }
}
