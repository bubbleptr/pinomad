import PinomadCore
import SwiftUI

/// Remove another device from the account (#452, ADR-0037 §3), pushed from
/// the account sheet. Confirmed again, as for deleting the account: a
/// session left on a lost phone mustn't be able to remove the owner's other
/// devices.
struct RemoveDeviceView: View {
    let model: AppModel
    let device: AccountDevice

    @Environment(\.dismiss) private var dismiss
    @State private var step = IdentityConfirmation()
    @State private var error: String?
    @State private var busy = false

    private var name: String { device.name ?? "this device" }

    var body: some View {
        Form {
            ConfirmIdentitySection(
                model: model, step: step,
                footer: AccountCopy.removeDeviceExplanation(name: name, hosts: model.accountRows),
                onSubmit: submit)

            FormActionButton(title: "Remove Device", busy: busy, destructive: true, error: error, action: submit)
                .disabled(busy || !step.ready)
        }
        .navigationTitle("Remove \(device.name ?? "Device")")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(busy)
    }

    private func submit() {
        guard !busy, step.ready else { return }
        busy = true
        error = nil
        Task {
            let failure = await step.run(model: model) { await model.accountKickDevice(device, confirmation: $0) }
            busy = false
            if let failure {
                error = step.unclaimed(failure).map(AccountCopy.message)
            } else {
                dismiss()
            }
        }
    }
}
