import PinomadCore
import SwiftUI

/// The confirmation a guarded action asks for (ADR-0044 §6), as one form
/// section: the password on an account that has one, else a code mailed to
/// the account's email. Each action keeps its own button and copy; this
/// supplies the value through `IdentityConfirmation.run`.
struct ConfirmIdentitySection: View {
    let model: AppModel
    @Bindable var step: IdentityConfirmation
    var passwordLabel = "Password"
    var footer: String?
    var onSubmit: () -> Void = {}

    var body: some View {
        Section {
            switch step.method {
            case .loading:
                ProgressView().controlSize(.small)
            case .password:
                SecureField(passwordLabel, text: $step.password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit(onSubmit)
            case .code:
                Text("We'll email a code to \(model.accountSession?.email ?? "your account's email").")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if step.sent {
                    TextField("Confirmation code", text: $step.code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .submitLabel(.go)
                        .onSubmit(onSubmit)
                }
                if let error = step.sendError {
                    Text("Couldn't send the code. " + AccountCopy.message(error))
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                Button {
                    Task { await step.send { await model.accountRequestReauthCode() } }
                } label: {
                    HStack(spacing: 8) {
                        Text(step.sent ? "Resend code" : "Send code")
                        if step.sending { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(step.sending)
            }
        } footer: {
            if let footer { Text(footer) }
        }
        .task {
            guard step.method == .loading else { return }
            if model.accountIdentities == nil, !model.accountIdentitiesUnsupported {
                await model.accountRefreshIdentities()
            }
            step.load(hasPassword: model.accountIdentitiesUnsupported ? nil : model.accountIdentities?.hasPassword)
        }
    }
}

extension IdentityConfirmation {
    /// Confirm, then run the action with that confirmation. A refused grant
    /// puts the step back to Send code; the action's other fields stay.
    func run(model: AppModel, _ action: (AccountConfirmation) async -> AccountFailure?) async -> AccountFailure? {
        switch await confirm(reauth: { await model.accountReauth($0) }) {
        case .failure(let failure):
            return failure
        case .success(let confirmation):
            let failure = await action(confirmation)
            if let failure { refused(failure) }
            return failure
        }
    }
}

/// The full-width button at the foot of a confirmed form.
struct FormActionButton: View {
    let title: String
    let busy: Bool
    var destructive = false
    let action: () -> Void

    var body: some View {
        Section {
            Button(role: destructive ? .destructive : nil, action: action) {
                HStack {
                    Spacer()
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(title)
                    }
                    Spacer()
                }
            }
            .buttonStyle(.tactile(.glassProminent))
            .tint(destructive ? Color.red : nil)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets())
        }
    }
}

/// An error under a form, red, in its own section.
struct FormErrorSection: View {
    let message: String?

    var body: some View {
        if let message {
            Section {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }
}
