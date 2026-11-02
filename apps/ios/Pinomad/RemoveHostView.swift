import PinomadCore
import SwiftUI

/// Take a host off the account (#512), pushed from its row or from the
/// new-host notice. The password again, as for removing a device: a session
/// left on a lost phone mustn't be able to cut the owner's hosts loose, and
/// only that machine's terminal brings one back.
struct RemoveHostView: View {
    let model: AppModel
    let host: PendingAccountHost
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
                Text(AccountCopy.removeHostExplanation(
                    name: host.name, server: server, pairedHere: model.removedHostPairing(host.hostId)))
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
                            Text("Remove Host")
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
        .navigationTitle("Remove \(host.name)")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.accountRemoveHost(host, password: password)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                dismiss()
            }
        }
    }
}
