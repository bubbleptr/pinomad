import PinomadCore
import SwiftUI

/// Take a host off the account (#512), pushed from its row or from the
/// new-host notice. Confirmed again, as for removing a device: a session
/// left on a lost phone mustn't be able to cut the owner's hosts loose, and
/// only that machine's terminal brings one back.
struct RemoveHostView: View {
    let model: AppModel
    let host: PendingAccountHost
    let server: String

    @Environment(\.dismiss) private var dismiss
    @State private var step = IdentityConfirmation()
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            ConfirmIdentitySection(
                model: model, step: step,
                footer: AccountCopy.removeHostExplanation(
                    name: host.name, server: server, pairedHere: model.removedHostPairing(host.hostId)),
                onSubmit: submit)

            FormActionButton(title: "Remove Host", busy: busy, destructive: true, action: submit)
                .disabled(busy || !step.ready)

            FormErrorSection(message: error)
        }
        .navigationTitle("Remove \(host.name)")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, step.ready else { return }
        busy = true
        error = nil
        Task {
            let failure = await step.run(model: model) { await model.accountRemoveHost(host, confirmation: $0) }
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            } else {
                dismiss()
            }
        }
    }
}
