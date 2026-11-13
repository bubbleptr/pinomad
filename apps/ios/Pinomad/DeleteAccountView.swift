import PinomadCore
import SwiftUI

/// Delete the account from the iPhone (#451; App Store guideline 5.1.1(v)
/// wants it in the app). Confirmed again — the password, or a mailed code on
/// an account without one (ADR-0044 §6) — then the server deletes the
/// account and every session, and the sheet lands signed out. Paired hosts
/// stay paired: revocation lives on the host (ADR-0022 §6).
struct DeleteAccountView: View {
    let model: AppModel
    let server: String

    @Environment(\.dismiss) private var dismiss
    @State private var step = IdentityConfirmation()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            ConfirmIdentitySection(
                model: model, step: step,
                footer: AccountCopy.deleteAccountExplanation(server: server),
                onSubmit: submit)

            FormActionButton(title: "Delete Account", busy: busy, destructive: true, error: error, action: submit)
                .disabled(busy || !step.ready)
        }
        .navigationTitle("Delete Account")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, step.ready else { return }
        busy = true
        error = nil
        Task {
            let failure = await step.run(model: model) { await model.accountDeleteAccount(confirmation: $0) }
            busy = false
            if let failure {
                error = step.unclaimed(failure).map(AccountCopy.message)
            } else {
                // Signed out by now; the sheet shows the sign-in form and
                // says the account is gone.
                dismiss()
            }
        }
    }
}
