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
                    .onChange(of: step.password) { step.clearFieldError() }
                FieldError(message: step.fieldError.map(AccountCopy.message))
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
                        .onChange(of: step.code) { step.clearFieldError() }
                    FieldError(message: step.fieldError.map(AccountCopy.message))
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
                FieldError(message: step.sendError.map(AccountCopy.message))
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
    /// A refused grant is asked again rather than blamed on a field; a
    /// refused password or code this step asked for shows on its field.
    func run(model: AppModel, _ action: (AccountConfirmation) async -> AccountFailure?) async -> AccountFailure? {
        clearFieldError()
        switch await confirm(reauth: { await model.accountReauth($0) }) {
        case .failure(let failure):
            claim(failure, duringConfirm: true)
            return failure
        case .success(let confirmation):
            let failure = await action(confirmation)
            if let failure, !refused(failure) { claim(failure, duringConfirm: false) }
            return failure
        }
    }

    /// `failure` unless this step showed it on its own field.
    func unclaimed(_ failure: AccountFailure?) -> AccountFailure? {
        fieldError == nil ? failure : nil
    }
}

/// The full-width button at the foot of a confirmed form, with the form's
/// error right under it: the message only, since the button already says
/// what was tried.
struct FormActionButton: View {
    let title: String
    let busy: Bool
    var destructive = false
    var error: String?
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
        } footer: {
            FieldError(message: error)
        }
    }
}
