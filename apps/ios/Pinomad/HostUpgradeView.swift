import PinomadChat
import PinomadCore
import SwiftUI

/// Settings → host → Upgrade (ADR-0043): the host's release, a newer one if
/// npm has it, and the upgrade in progress — all from the `upgrade` stream,
/// so another device starting or cancelling shows here too. A host that
/// can't upgrade itself shows the command to run on it instead.
struct HostUpgradeView: View {
    let model: AppModel
    let hostKey: String

    private enum Pending: Equatable { case start(UpgradeWhen), cancel, check, setting(AutoUpgradeMode) }

    @State private var confirming = false
    /// The call sent and not yet answered; one at a time.
    @State private var pending: Pending?
    @State private var error: String?

    var body: some View {
        Group {
            if hostKey != model.currentHostKey || model.snapshot == nil {
                ContentUnavailableView {
                    Label("Not connected to this host", image: .cloudOff)
                } description: {
                    Text("Connect to it to see its release.")
                }
            } else if let upgrade = model.snapshot?.upgrade, model.hostSupports("startUpgrade") {
                content(upgrade, mode: model.snapshot?.settings?.autoUpgrade)
            } else {
                ContentUnavailableView {
                    Label("This host is too old to upgrade from here", image: .triangleAlert)
                } description: {
                    Text("Run `pinomad upgrade` on the host.")
                }
            }
        }
        .navigationTitle("Upgrade")
        .navigationBarTitleDisplayMode(.inline)
        .reconnectingTitle(model, hostKey: hostKey)
    }

    private func content(_ upgrade: HostUpgradeState, mode: AutoUpgradeMode?) -> some View {
        let controls = UpgradeControls(upgrade, connected: model.connected)
        return List {
            Section {
                LabeledContent("Running", value: upgrade.current.map { "pinomad \($0)" } ?? "Source checkout")
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(UpgradeSummary.text(
                        upgrade, checksOff: mode == .off, now: context.date.timeIntervalSince1970 * 1000))
                        .foregroundStyle(.secondary)
                }
                if let available = upgrade.available, available.crossesMajor, upgrade.phase == .idle {
                    Text("Apps that haven't updated yet can't connect to this release.")
                        .foregroundStyle(.secondary)
                }
                if controls.canStart {
                    // The dialog's buttons dismiss it on tap; the pending row and the
                    // inline error carry the host's answer instead.
                    Button("Upgrade") { confirming = true }
                        .disabled(pending != nil)
                        .confirmationDialog(
                            "Upgrade the host to pinomad \(upgrade.available?.version ?? "")?",
                            isPresented: $confirming,
                            titleVisibility: .visible
                        ) {
                            Button("Upgrade when idle") { start(.idle) }
                            Button("Upgrade now") { start(.now) }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text(confirmMessage(crossesMajor: upgrade.available?.crossesMajor == true))
                        }
                }
                if controls.showsCancel {
                    actionButton("Cancel upgrade", busy: pending == .cancel) {
                        act(.cancel) { try await model.cancelUpgrade(on: hostKey) }
                    }
                    .disabled(!model.connected || pending != nil)
                }
                if controls.showsCheckNow {
                    actionButton("Check now", busy: upgrade.checking || pending == .check) {
                        act(.check) { try await model.checkUpgrade(on: hostKey) }
                    }
                    .disabled(!model.connected || mode == .off || upgrade.checking || pending != nil)
                }
            }
            if case .start? = pending {
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Starting the upgrade…").foregroundStyle(.secondary)
                    }
                }
            }
            if let error {
                notice(.circleAlert, tint: .red, title: "That didn't go through", detail: error)
            }
            if let checkError = upgrade.checkError {
                notice(.triangleAlert, tint: .orange, title: "Couldn't check for releases", detail: checkError)
            }
            if controls.showsFailure, let failure = upgrade.failure {
                notice(.circleAlert, tint: .red, title: "Upgrading to pinomad \(failure.version) failed",
                       detail: failure.message, monospaced: true)
            }
            if let blocked = upgrade.blocked {
                let text = UpgradeSummary.blocked(blocked)
                notice(.info, tint: .secondary, title: text.title, detail: text.detail)
            }
            if let mode, model.hostSupports(.autoUpgrade) {
                Section {
                    // The choice shows while the host saves it; a refusal or
                    // timeout falls back to the host's value.
                    Picker("Automatic upgrades", selection: Binding(
                        get: { shownMode(mode) },
                        set: { next in
                            guard next != mode else { return }
                            act(.setting(next)) { try await model.setAutoUpgrade(next, on: hostKey) }
                        }
                    )) {
                        Text("Off").tag(AutoUpgradeMode.off)
                        Text("Notify").tag(AutoUpgradeMode.notify)
                        Text("When idle").tag(AutoUpgradeMode.auto)
                    }
                    .pickerStyle(.segmented)
                    .disabled(!model.connected || pending != nil)
                } header: {
                    HStack {
                        Text("Automatic upgrades")
                        if case .setting? = pending { ProgressView().controlSize(.small) }
                    }
                } footer: {
                    Text(UpgradeSummary.autoDescription(shownMode(mode)))
                }
            }
        }
    }

    private func shownMode(_ host: AutoUpgradeMode) -> AutoUpgradeMode {
        if case .setting(let chosen)? = pending { chosen } else { host }
    }

    private func confirmMessage(crossesMajor: Bool) -> String {
        var text = "The host restarts after installing, and every device reconnects. Open terminals close."
        if crossesMajor { text += " Apps that haven't updated yet can't connect to this release." }
        return text + " Upgrading now interrupts running tasks; they continue after the restart."
    }

    private func start(_ when: UpgradeWhen) {
        act(.start(when)) { try await model.startUpgrade(when, on: hostKey) }
    }

    private func act(_ kind: Pending, _ call: @escaping () async throws -> Void) {
        error = nil
        pending = kind
        Task {
            do { try await call() } catch { self.error = model.describe(error) }
            pending = nil
        }
    }

    private func actionButton(_ title: String, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                if busy { ProgressView() }
            }
        }
    }

    private func notice(
        _ icon: ImageResource, tint: Color, title: String, detail: String, monospaced: Bool = false
    ) -> some View {
        Section {
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                    // Markdown, so a command in backticks reads as code.
                    Text(monospaced ? AttributedString(detail) : (try? AttributedString(markdown: detail)) ?? AttributedString(detail))
                        .font(monospaced ? .footnote.monospaced() : .footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } icon: {
                Image(icon).foregroundStyle(tint)
            }
        }
    }
}
