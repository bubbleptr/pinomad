import PinomadCore
import SwiftUI

/// Remove another device from the account (#452, ADR-0037 §3), pushed from
/// the account sheet. The password again, as for deleting the account: a
/// session left on a lost phone mustn't be able to remove the owner's other
/// devices.
struct RemoveDeviceView: View {
    let model: AppModel
    let device: AccountDevice

    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    private var name: String { device.name ?? "this device" }

    var body: some View {
        Form {
            Section {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit(submit)
            } footer: {
                Text(AccountCopy.removeDeviceExplanation(name: name, hosts: model.accountRows))
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
                            Text("Remove Device")
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
        .navigationTitle("Remove \(device.name ?? "Device")")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.accountKickDevice(device, password: password)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                dismiss()
            }
        }
    }
}
