import PinomadCore
import SwiftUI

/// Change the account password (#450), pushed from the account sheet. This
/// device stays signed in and the account's other sessions end. A forgotten
/// password has no screen: the server's admin resets it.
struct ChangePasswordView: View {
    let model: AppModel
    let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                SecureField("Current Password", text: $current)
                    .textContentType(.password)
                    .submitLabel(.next)
                SecureField("New Password", text: $new)
                    .textContentType(.newPassword)
                    .submitLabel(.go)
                    .onSubmit(submit)
            } footer: {
                Text("At least 12 characters. Your other devices will be signed out.")
            }

            Section {
                Button {
                    submit()
                } label: {
                    HStack {
                        Spacer()
                        if busy {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Change Password")
                        }
                        Spacer()
                    }
                }
                .buttonStyle(.tactile(.glassProminent))
                .disabled(busy || current.isEmpty || new.isEmpty)
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
        .navigationTitle("Change Password")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, !current.isEmpty, !new.isEmpty else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.accountChangePassword(current: current, new: new)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                onChanged()
                dismiss()
            }
        }
    }
}
