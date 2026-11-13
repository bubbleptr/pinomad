import AuthenticationServices
import PinomadCore
import SwiftUI

/// Setting the account's email (ADR-0044 §8): confirmed like any account
/// change, then a code mailed to the new address. "Change email" and the
/// email a legacy account must add before going on both use it.
struct EmailFormSections: View {
    let model: AppModel
    let submitLabel: String
    let onSaved: () -> Void

    @State private var step = IdentityConfirmation()
    @State private var email = ""
    @State private var sentTo: String?
    @State private var code = ""
    @State private var busy = false
    @State private var failure: AccountFailure?
    /// The grant lapsed after the new address got its code: confirm again here.
    @State private var reconfirm = false

    var body: some View {
        if let sentTo {
            Section {
                Text("Enter the 6-digit code we sent to \(sentTo).")
                    .font(.footnote)
                TextField("Code", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .submitLabel(.go)
                    .onSubmit(save)
                    .onChange(of: code) { clear(.code) }
                FieldError(message: AccountCopy.fieldMessage(failure, .code))
            }
            if reconfirm {
                ConfirmIdentitySection(model: model, step: step, onSubmit: save)
            }
            FormActionButton(
                title: submitLabel, busy: busy,
                error: AccountCopy.formMessage(failure, fields: [.code]), action: save)
                .disabled(busy || code.trimmed.isEmpty || !step.ready)
            Section {
                Button("Use a different email") {
                    self.sentTo = nil
                    code = ""
                    failure = nil
                    reconfirm = false
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
                    .submitLabel(.next)
                    .onChange(of: email) { clear(.email) }
                FieldError(message: AccountCopy.fieldMessage(failure, .email))
            }
            ConfirmIdentitySection(model: model, step: step, onSubmit: send)
            FormActionButton(
                title: "Send code to new email", busy: busy,
                error: AccountCopy.formMessage(failure, fields: [.email]), action: send)
                .disabled(busy || email.trimmed.isEmpty || !step.ready)
        }
    }

    private func clear(_ field: AccountField) {
        if failure.flatMap(AccountCopy.field) == field { failure = nil }
    }

    private func send() {
        let address = email.trimmed
        guard !busy, !address.isEmpty, step.ready else { return }
        run({ await model.accountRequestEmailCode(email: address, confirmation: $0) }) {
            sentTo = address
        }
    }

    private func save() {
        guard let sentTo, !busy, !code.trimmed.isEmpty, step.ready else { return }
        let typed = code.trimmed
        run({ await model.accountSetEmail(email: sentTo, code: typed, confirmation: $0) }, then: onSaved)
    }

    private func run(_ call: @escaping (AccountConfirmation) async -> AccountFailure?, then: @escaping () -> Void) {
        busy = true
        failure = nil
        Task {
            let refused = await step.run(model: model, call)
            busy = false
            if let refused {
                // Back to the confirmation, with what was typed kept.
                if refused.code == "invalid_reauth" { reconfirm = true }
                failure = step.unclaimed(refused)
            } else {
                then()
            }
        }
    }
}

/// Holds the account back while the server wants an email for a legacy
/// account (ADR-0044 §8): in place of the account sheet until it's saved.
struct AddEmailView: View {
    let model: AppModel

    var body: some View {
        Form {
            // A row, not a section header: headers draw their text in the
            // secondary header color whatever the style asks for.
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Add an email to your account")
                        .font(.title3.weight(.semibold))
                    Text("You'll sign in with it from now on, and sign-in codes go there.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            }
            EmailFormSections(model: model, submitLabel: "Save") {}
            Section {
                Button("Sign out") {
                    Task { await model.accountSignOut(everywhere: false) }
                }
                .disabled(model.accountBusy)
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled()
    }
}

/// "Change email", pushed from the account sheet.
struct ChangeEmailView: View {
    let model: AppModel
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            EmailFormSections(model: model, submitLabel: "Save") {
                onSaved()
                dismiss()
            }
        }
        .navigationTitle(model.accountSession?.email == nil ? "Add Email" : "Change Email")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Remove a provider from the account's sign-in methods (ADR-0044 §4).
struct UnlinkProviderView: View {
    let model: AppModel
    let provider: String
    let onRemoved: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var step = IdentityConfirmation()
    @State private var busy = false
    @State private var error: String?

    private var name: String { SignInProviders.name(provider) }

    var body: some View {
        Form {
            ConfirmIdentitySection(
                model: model, step: step,
                footer: "You won't be able to sign in with \(name) until you link it again.",
                onSubmit: submit)
            FormActionButton(title: "Remove \(name)", busy: busy, destructive: true, error: error, action: submit)
                .disabled(busy || !step.ready)
        }
        .navigationTitle("Remove \(name)")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, step.ready else { return }
        busy = true
        error = nil
        Task {
            let failure = await step.run(model: model) { await model.accountUnlinkProvider(provider, confirmation: $0) }
            busy = false
            if let failure {
                error = step.unclaimed(failure).map(AccountCopy.message)
            } else {
                onRemoved("\(name) removed.")
                dismiss()
            }
        }
    }
}

/// Add a provider to the account's sign-in methods (ADR-0044 §4, #631):
/// confirmed like removing one, then Google or GitHub in the system browser,
/// or Apple's own sheet. Closing either sheet just stops; a link that comes
/// back after the session changed is dropped by the model.
struct LinkProviderView: View {
    let model: AppModel
    let provider: String
    let onLinked: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var step = IdentityConfirmation()
    @State private var appleRequest = AppleSignInRequest()
    @State private var busy = false
    @State private var error: String?

    private var name: String { SignInProviders.name(provider) }

    var body: some View {
        Form {
            ConfirmIdentitySection(
                model: model, step: step,
                footer: "Then sign in with \(name) to add it to this account.",
                onSubmit: submit)
            FormActionButton(title: "Link \(name)", busy: busy, error: error, action: submit)
                .disabled(busy || !step.ready)
        }
        .navigationTitle("Link \(name)")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, step.ready else { return }
        busy = true
        error = nil
        if provider == "apple" { startApple() } else { startWeb() }
    }

    private func startWeb() {
        let session = webAuthenticationSession
        run { confirmation in
            await model.accountLinkProvider(provider, confirmation: confirmation) { url in
                // The shared browser session, as for signing in: the
                // server's page sets the cookie the provider's answer is
                // checked against, and a reader already signed in to the
                // provider there isn't asked again.
                try? await session.authenticate(
                    using: url,
                    callback: .customScheme(NativeOAuth.callbackScheme),
                    preferredBrowserSession: .shared,
                    additionalHeaderFields: [:])
            }
        }
    }

    private func startApple() {
        // Taken at the press, so a sign-out while Apple's sheet is up drops it.
        let attempt = model.beginAppleSignIn()
        appleRequest.start { request in
            request.requestedScopes = [.fullName, .email]
            request.nonce = AppleNonce.sha256Hex(attempt.nonce)
        } completion: { result in
            switch result {
            case .failure(let failure):
                busy = false
                // Closing Apple's sheet is not an error worth showing.
                if (failure as? ASAuthorizationError)?.code != .canceled {
                    error = AccountCopy.linkMessage(AccountFailure(code: "access_denied"), provider: name)
                }
            case .success(let authorization):
                guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                    busy = false
                    return
                }
                run { confirmation in
                    await model.finishAppleLink(
                        ticket: attempt.ticket, nonce: attempt.nonce, credential: credential,
                        confirmation: confirmation)
                }
            }
        }
    }

    /// Confirms, then links. A refused password or lapsed grant leaves the
    /// form up to confirm again (`IdentityConfirmation.run`).
    private func run(_ link: @escaping (AccountConfirmation) async -> ProviderLinkResult) {
        Task {
            var outcome = ProviderLinkResult.cancelled
            let failure = await step.run(model: model) { confirmation in
                outcome = await link(confirmation)
                if case .failed(let failure) = outcome { return failure }
                return nil
            }
            busy = false
            if let failure = step.unclaimed(failure) {
                error = AccountCopy.linkMessage(failure, provider: name)
            } else if outcome == .linked {
                onLinked("\(name) linked.")
                dismiss()
            }
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
