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
    @State private var error: String?
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
            }
            if reconfirm {
                ConfirmIdentitySection(model: model, step: step, onSubmit: save)
            }
            FormActionButton(title: submitLabel, busy: busy, action: save)
                .disabled(busy || code.trimmed.isEmpty || !step.ready)
            Section {
                Button("Use a different email") {
                    self.sentTo = nil
                    code = ""
                    error = nil
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
            }
            ConfirmIdentitySection(model: model, step: step, onSubmit: send)
            FormActionButton(title: "Send code to new email", busy: busy, action: send)
                .disabled(busy || email.trimmed.isEmpty || !step.ready)
        }
        FormErrorSection(message: error.map { (sentTo == nil ? "Couldn't send the code. " : "Couldn't save the email. ") + $0 })
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
        error = nil
        Task {
            let failure = await step.run(model: model, call)
            busy = false
            if let failure {
                // Back to the confirmation, with what was typed kept.
                if failure.code == "invalid_reauth" { reconfirm = true }
                error = AccountCopy.message(failure)
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
            Section {
            } header: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Add an email to your account")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("You'll sign in with it from now on, and sign-in codes go there.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .textCase(nil)
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
            FormActionButton(title: "Remove \(name)", busy: busy, destructive: true, action: submit)
                .disabled(busy || !step.ready)
            FormErrorSection(message: error)
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
                error = AccountCopy.message(failure)
            } else {
                onRemoved("\(name) removed.")
                dismiss()
            }
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
