import PinomadCore
import SwiftUI

/// Delete the account from the iPhone (#451; App Store guideline 5.1.1(v)
/// wants it in the app). The password again, then the server deletes the
/// account and every session, and the sheet lands signed out. Paired hosts
/// stay paired: revocation lives on the host (ADR-0022 §6).
struct DeleteAccountView: View {
    let model: AppModel
    let server: String

    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit(submit)
            } footer: {
                Text(AccountCopy.deleteAccountExplanation(server: server))
            }

            Section {
                Button(role: .destructive) {
                    submit()
                } label: {
                    HStack {
                        Spacer()
                        if busy {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Delete Account")
                        }
                        Spacer()
                    }
                }
                .buttonStyle(.tactile(.glassProminent))
                .tint(.red)
                .disabled(busy || password.isEmpty)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }

            if let error {
                Section {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Delete Account")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.accountDeleteAccount(password: password)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                // Signed out by now; the sheet shows the sign-in form and
                // says the account is gone.
                dismiss()
            }
        }
    }
}
