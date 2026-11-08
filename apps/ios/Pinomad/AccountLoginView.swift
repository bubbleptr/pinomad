import AuthenticationServices
import PinomadCore
import SwiftUI

/// Sign in to the one account (ADR-0022, ADR-0044). Sign in with Apple
/// first, then Google and GitHub — each only when the server offers it —
/// then email and password, with creating an account and resetting a
/// password as steps of their own. The server address sits at the foot: it
/// starts at the last server signed in to, or the official one, and is
/// probed on appear; an insecure address never leaves the device. A
/// successful sign-in swaps the sheet to the account.
struct AccountLoginView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var origin: String
    @State private var email: String
    @State private var password = ""
    @State private var phase = ProbePhase.idle
    @State private var methods: AuthMethods?
    @State private var error: String?
    @State private var notice: String?
    /// "password", a provider id, or nil.
    @State private var busy: String?
    @State private var codeFlow: CodeFlowKind?
    @State private var appleAttempt: (ticket: SignInTicket, nonce: String)?
    @State private var appleRequest = AppleSignInRequest()

    private enum ProbePhase: Equatable {
        case idle
        case probing
        case enabled
        case disabled
        case unreachable
    }

    init(model: AppModel) {
        self.model = model
        // Seeded here rather than on appear: assigning in `.task` would fire
        // the address field's onChange and reset the probe it starts.
        _origin = State(initialValue: model.accountRecord?.serverOrigin ?? OfficialServer.origin)
        _email = State(initialValue: model.accountRecord?.username ?? "")
    }

    private var server: String { origin.trimmed }

    var body: some View {
        Form {
            // Why the reader is signed out, when it wasn't their doing
            // (expired, revoked) or the token outlived the sign-out.
            if model.accountNotice != nil || model.accountSignOutWarning != nil || notice != nil {
                Section {
                    ForEach([notice, model.accountNotice, model.accountSignOutWarning].compactMap { $0 }, id: \.self) {
                        Text($0)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }

            switch phase {
            case .enabled:
                signInSections
            case .probing:
                Section {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking the server…").foregroundStyle(.secondary)
                    }
                }
            case .disabled, .unreachable, .idle:
                EmptyView()
            }

            FormErrorSection(message: error)

            serverSection

            LegalLinksSection()
        }
        .navigationTitle("Sign In")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $codeFlow) { kind in
            CodeFlowView(model: model, kind: kind, origin: server, email: $email) {
                codeFlow = nil
                if kind == .reset {
                    notice = "Password reset. Sign in with your new password."
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(busy != nil)
            }
        }
        .interactiveDismissDisabled(busy != nil)
        .task {
            if phase == .idle { probe() }
            #if DEBUG
            if let page = model.devSignInPage {
                model.devSignInPage = nil
                switch page {
                case "create": codeFlow = .create
                case "reset": codeFlow = .reset
                case "apple-pending":
                    model.accountApplePending = ApplePendingSignIn(
                        id: String(repeating: "p", count: 43), serverOrigin: server,
                        email: "x7k2p9@privaterelay.appleid.com")
                default: break
                }
            }
            #endif
        }
    }

    // MARK: Sign-in

    private var offered: [String] {
        SignInProviders.ids.filter { methods?.providers.contains($0) == true }
    }

    @ViewBuilder
    private var signInSections: some View {
        if !offered.isEmpty {
            Section {
                ForEach(offered, id: \.self) { provider in
                    providerButton(provider)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                HStack(spacing: 12) {
                    VStack { Divider() }
                    Text("or").font(.footnote).foregroundStyle(.secondary)
                    VStack { Divider() }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 0, trailing: 0))
            }
        }

        Section {
            TextField("Email", text: $email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
            SecureField("Password", text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .onSubmit(login)
        } footer: {
            Text("See the hosts on your account and connect without a QR code.")
        }

        Section {
            Button(action: login) {
                HStack {
                    Spacer()
                    if busy == "password" {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Sign in")
                    }
                    Spacer()
                }
                .frame(height: Self.buttonLabelHeight)
            }
            .buttonStyle(.tactile(.glassProminent))
            .disabled(busy != nil || email.trimmed.isEmpty || password.isEmpty)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets())

            if methods?.email == true {
                HStack {
                    Button("Forgot password?") { go(.reset) }
                    Spacer()
                    if methods?.registration == true {
                        Button("Create an account") { go(.create) }
                    }
                }
                .buttonStyle(.borderless)
                .font(.subheadline)
                .disabled(busy != nil)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 0, trailing: 4))
            }
        }
    }

    private static let providerButtonHeight: CGFloat = 50
    /// "Sign in" lands at the provider buttons' height once the glass
    /// style adds its own padding around the label.
    private static let buttonLabelHeight: CGFloat = 36

    /// All provider buttons are ours, one shape and size: Apple's guidelines
    /// allow a custom Sign in with Apple button (black or white, Apple logo,
    /// "Continue with Apple"), so its logo can sit at the size the Google
    /// and GitHub marks do. Only the authorization sheet is the system's.
    private func providerButton(_ provider: String) -> some View {
        let apple = provider == "apple"
        let fill: Color = apple ? (colorScheme == .dark ? .white : .black) : Color(.tertiarySystemFill)
        let ink: Color = apple ? (colorScheme == .dark ? .black : .white) : .primary
        return Button {
            if apple { startApple() } else { startProvider(provider) }
        } label: {
            HStack(spacing: 10) {
                Spacer()
                if busy == provider {
                    ProgressView().controlSize(.small).tint(ink)
                } else {
                    SignInProviderMark(provider: provider)
                }
                Text("Continue with \(SignInProviders.name(provider))")
                Spacer()
            }
            .font(.body.weight(.medium))
            .frame(minHeight: Self.providerButtonHeight)
            .foregroundStyle(ink)
            .background(fill, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.press)
        .disabled(busy != nil)
    }

    private func startApple() {
        guard busy == nil else { return }
        let attempt = model.beginAppleSignIn()
        appleAttempt = attempt
        error = nil
        appleRequest.start { request in
            request.requestedScopes = [.fullName, .email]
            request.nonce = AppleNonce.sha256Hex(attempt.nonce)
        } completion: { result in
            finishApple(result)
        }
    }

    private func go(_ kind: CodeFlowKind) {
        error = nil
        notice = nil
        codeFlow = kind
    }

    private func login() {
        let user = email.trimmed
        guard busy == nil, !server.isEmpty, !user.isEmpty, !password.isEmpty else { return }
        busy = "password"
        error = nil
        notice = nil
        Task {
            let failure = await model.accountLogin(origin: server, username: user, password: password)
            busy = nil
            if let failure { error = AccountCopy.message(failure) }
        }
    }

    private func startProvider(_ provider: String) {
        guard busy == nil else { return }
        busy = provider
        error = nil
        notice = nil
        let session = webAuthenticationSession
        Task {
            let failure = await model.accountProviderSignIn(origin: server, provider: provider) { url in
                // The system browser, sharing its cookies: a reader already
                // signed in to the provider there isn't asked again.
                try? await session.authenticate(
                    using: url,
                    callback: .customScheme(NativeOAuth.callbackScheme),
                    preferredBrowserSession: .shared,
                    additionalHeaderFields: [:])
            }
            busy = nil
            if let failure { error = AccountCopy.message(failure) }
        }
    }

    private func finishApple(_ result: Result<ASAuthorization, any Error>) {
        guard let attempt = appleAttempt else { return }
        appleAttempt = nil
        switch result {
        case .failure(let failure):
            // Closing Apple's sheet is not an error worth showing.
            if (failure as? ASAuthorizationError)?.code != .canceled {
                error = AccountCopy.message(AccountFailure(code: "access_denied"))
            }
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else { return }
            busy = "apple"
            Task {
                let failure = await model.finishAppleSignIn(
                    origin: server, ticket: attempt.ticket, nonce: attempt.nonce, credential: credential)
                busy = nil
                if let failure { error = AccountCopy.message(failure) }
            }
        }
    }

    // MARK: Server

    private var serverSection: some View {
        Section {
            TextField("https://…", text: $origin)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.continue)
                .disabled(phase == .probing || busy != nil)
                .onSubmit(probe)
                .onChange(of: origin) { _, _ in
                    if phase != .idle { phase = .idle }
                    methods = nil
                    error = nil
                }

            switch phase {
            case .disabled:
                Text("This server doesn't have accounts turned on.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            case .unreachable:
                Text("Can't reach the server. Check the address and your connection.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            case .idle, .probing, .enabled:
                EmptyView()
            }

            if phase != .enabled {
                Button(phase == .probing ? "Checking…" : "Continue", action: probe)
                    .disabled(server.isEmpty || phase == .probing || busy != nil)
            }
        } header: {
            Text("Server")
        } footer: {
            Text("To use your own server, change the address. Accounts need https://; for local testing, http://127.0.0.1 works for email sign-in.")
        }
    }

    private func probe() {
        let server = self.server
        error = nil
        guard !server.isEmpty else {
            error = AccountCopy.message(AccountFailure(code: "origin_required"))
            return
        }
        guard isSecureServerOrigin(origin: server) else {
            phase = .idle
            error = AccountCopy.message(AccountFailure(code: "insecure_origin"))
            return
        }
        phase = .probing
        let normalized = normalizeServerOrigin(origin: server)
        Task {
            let verdict = await model.probeAccountServer(normalized)
            // A verdict for an address the field no longer holds is stale.
            guard normalizeServerOrigin(origin: self.server) == normalized else { return }
            switch verdict {
            case .enabled:
                // Which buttons to show; without an answer the email form
                // still works.
                let methods = await model.accountAuthMethods(normalized)
                guard normalizeServerOrigin(origin: self.server) == normalized else { return }
                self.methods = methods
                phase = .enabled
            case .disabled:
                phase = .disabled
            case .unreachable:
                phase = .unreachable
            }
        }
    }
}

enum CodeFlowKind: String, Identifiable, Hashable {
    case create
    case reset

    var id: String { rawValue }
}

/// How long Resend code waits after a send.
private let resendCooldown: TimeInterval = 30

/// A mailed-code flow in two steps, shared by sign-up and password reset:
/// the email and Send code, then the code and a new password.
struct CodeFlowView: View {
    let model: AppModel
    let kind: CodeFlowKind
    let origin: String
    @Binding var email: String
    let onDone: () -> Void

    @State private var sentTo: String?
    @State private var sentAt = Date.distantPast
    @State private var code = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    private var title: String { kind == .create ? "Create an Account" : "Reset Password" }

    var body: some View {
        Form {
            if let sentTo {
                Section {
                    Text("Enter the 6-digit code we sent to \(sentTo).")
                        .font(.footnote)
                    TextField("Code", text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .submitLabel(.next)
                    SecureField("New password", text: $password)
                        .textContentType(.newPassword)
                        .submitLabel(.go)
                        .onSubmit(finish)
                } footer: {
                    Text("At least 12 characters.")
                }
                FormActionButton(title: kind == .create ? "Create account" : "Reset password", busy: busy, action: finish)
                    .disabled(busy || code.trimmed.isEmpty || password.isEmpty)
                Section {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let wait = Int((sentAt.addingTimeInterval(resendCooldown).timeIntervalSince(context.date)).rounded(.up))
                        Button(wait > 0 ? "Resend code (\(wait)s)" : "Resend code") { send(sentTo) }
                            .disabled(wait > 0 || busy)
                    }
                    Button("Use a different email") {
                        self.sentTo = nil
                        code = ""
                        error = nil
                    }
                    .disabled(busy)
                }
            } else {
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .onSubmit { send(email.trimmed) }
                } footer: {
                    Text(kind == .create
                        ? "We'll email you a code to confirm it's yours."
                        : "If the email has an account, we'll send it a code.")
                }
                FormActionButton(title: "Send code", busy: busy) { send(email.trimmed) }
                    .disabled(busy || email.trimmed.isEmpty)
            }
            FormErrorSection(message: error.map { prefix + $0 })
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private var prefix: String {
        if sentTo == nil { return "Couldn't send the code. " }
        return kind == .create ? "Couldn't create the account. " : "Couldn't reset the password. "
    }

    private func send(_ address: String) {
        guard !address.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            let failure = kind == .create
                ? await model.accountRequestSignupCode(origin: origin, email: address)
                : await model.accountRequestPasswordReset(origin: origin, email: address)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                sentTo = address
                sentAt = .now
            }
        }
    }

    private func finish() {
        guard let sentTo, !busy, !code.trimmed.isEmpty, !password.isEmpty else { return }
        guard password.unicodeScalars.count >= 12 else {
            error = AccountCopy.message(AccountFailure(code: "weak_password"))
            return
        }
        busy = true
        error = nil
        let typed = code.trimmed
        Task {
            let failure = kind == .create
                ? await model.accountRegister(origin: origin, email: sentTo, code: typed, password: password)
                : await model.accountResetPassword(origin: origin, email: sentTo, code: typed, password: password)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                onDone()
            }
        }
    }
}

/// Sign in with Apple found no PiNomad account (ADR-0044 §4): create one, or
/// sign in to the one there is and add Apple to it. Google and GitHub show
/// this step on the server's page inside the browser sheet instead.
struct AppleNoAccountView: View {
    let model: AppModel
    let pending: ApplePendingSignIn

    @Environment(\.dismiss) private var dismiss
    @State private var linking = false
    @State private var asksPassword = false
    @State private var newPassword = ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var expired = false

    private var who: String { pending.email ?? "this Apple ID" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        SignInProviderMark(provider: "apple", size: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Apple").font(.headline)
                            Text(pending.email ?? "Email not shared")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                } footer: {
                    Text("No PiNomad account for \(who) yet")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .padding(.top, 12)
                }

                if expired {
                    Section {
                        Text("This sign-in expired. Start again.")
                        Button("Back to sign-in") { close() }
                    }
                } else if linking {
                    linkSections
                } else {
                    createSections
                }

                FormErrorSection(message: error)
            }
            .navigationTitle("Finish Signing In")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { close() }
                        .disabled(busy)
                }
            }
            .interactiveDismissDisabled(busy)
            .task {
                // A server that can't mail codes needs a password: the
                // account's only way to confirm changes later.
                if await model.accountAuthMethods(pending.serverOrigin)?.email == false { asksPassword = true }
            }
        }
    }

    @ViewBuilder
    private var createSections: some View {
        if asksPassword {
            Section {
                SecureField("New password", text: $newPassword)
                    .textContentType(.newPassword)
                    .submitLabel(.go)
                    .onSubmit(create)
            } footer: {
                Text("At least 12 characters. You'll use it to confirm changes to your account.")
            }
        }
        FormActionButton(title: "Create account", busy: busy, action: create)
            .disabled(busy || (asksPassword && newPassword.isEmpty))
        Section {
            Button("I already have an account") {
                error = nil
                linking = true
            }
            .frame(maxWidth: .infinity)
            .disabled(busy)
        }
    }

    @ViewBuilder
    private var linkSections: some View {
        Section {
            if model.accountSession == nil {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
            }
            SecureField("Password", text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .onSubmit(link)
        } footer: {
            Text("Signed up with Google or GitHub? Sign in with it first, then add Apple from Settings on the web.")
        }
        FormActionButton(title: model.accountSession == nil ? "Sign in and link Apple" : "Link Apple", busy: busy, action: link)
            .disabled(busy || password.isEmpty || (model.accountSession == nil && email.trimmed.isEmpty))
        Section {
            Button("Back") {
                error = nil
                linking = false
            }
            .disabled(busy || model.accountSession != nil)
        }
    }

    private func create() {
        guard !busy else { return }
        if asksPassword, newPassword.unicodeScalars.count < 12 {
            error = AccountCopy.message(AccountFailure(code: "weak_password"))
            return
        }
        busy = true
        error = nil
        Task {
            let failure = await model.accountCreateFromPending(pending, password: asksPassword ? newPassword : nil)
            busy = false
            settle(failure)
            if failure?.code == "password_required" {
                asksPassword = true
                error = nil
            }
        }
    }

    private func link() {
        guard !busy, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.accountSignInAndLinkPending(pending, email: email.trimmed, password: password)
            busy = false
            settle(failure)
        }
    }

    private func settle(_ failure: AccountFailure?) {
        guard let failure else { return }
        if failure.code == "not_found" {
            expired = true
        } else {
            error = AccountCopy.message(failure)
        }
    }

    private func close() {
        model.accountApplePending = nil
        dismiss()
    }
}
