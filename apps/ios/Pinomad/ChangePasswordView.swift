import PinomadCore
import SwiftUI

/// Change the account password (#450), or set a first one on an account
/// that signs in with a provider only (ADR-0044 §6), pushed from Sign-in
/// Methods. This device stays signed in and the account's other sessions
/// end. A forgotten password is reset from the sign-in screen.
struct ChangePasswordView: View {
    let model: AppModel
    /// False: the account has no password yet, and this sets one.
    let hasPassword: Bool
    let onChanged: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var step = IdentityConfirmation()
    @State private var new = ""
    @State private var error: String?
    @State private var busy = false

    private var verb: String { hasPassword ? "Change Password" : "Set Password" }

    var body: some View {
        Form {
            ConfirmIdentitySection(
                model: model, step: step,
                passwordLabel: "Current Password",
                onSubmit: submit)

            Section {
                SecureField("New Password", text: $new)
                    .textContentType(.newPassword)
                    .submitLabel(.go)
                    .onSubmit(submit)
            } footer: {
                Text("At least 12 characters. Your other devices will be signed out.")
            }

            FormActionButton(title: verb, busy: busy, action: submit)
                .disabled(busy || !step.ready || new.isEmpty)

            FormErrorSection(message: error)
        }
        .navigationTitle(verb)
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, step.ready, !new.isEmpty else { return }
        // Checked here first, as the server would: the code isn't spent on it.
        guard new.unicodeScalars.count >= 12 else {
            error = AccountCopy.message(AccountFailure(code: "weak_password"))
            return
        }
        busy = true
        error = nil
        Task {
            let failure = await step.run(model: model) { await model.accountChangePassword(current: $0, new: new) }
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                onChanged(hasPassword ? "Password changed. Your other devices were signed out." : "Password set.")
                dismiss()
            }
        }
    }
}
