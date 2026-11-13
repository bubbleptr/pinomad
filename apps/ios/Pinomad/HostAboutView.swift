import PinomadChat
import PinomadCore
import SwiftUI

/// Settings → host → About: the name every paired device shows it by, its
/// release and upgrading it (ADR-0043), and the protocol it speaks.
struct HostAboutView: View {
    let model: AppModel
    let hostKey: String

    @State private var renaming = false
    @State private var nameDraft = ""

    var body: some View {
        HostPage(model: model, hostKey: hostKey, title: "About") { snapshot in
            if snapshot.settings != nil && model.hostSupports(.hostName) {
                hostNameSection(snapshot)
            }
            if let upgrade = snapshot.upgrade, model.hostSupports("startUpgrade") {
                HostUpgradeSections(model: model, hostKey: hostKey, upgrade: upgrade,
                                    mode: snapshot.settings?.autoUpgrade)
            } else {
                Section {
                    LabeledContent("Running", value: snapshot.host?.version.map { "pinomad \($0)" } ?? "Source checkout")
                } header: {
                    Text("Version")
                } footer: {
                    Text("This host is too old to upgrade from here. Run `pinomad upgrade` on the host.")
                }
            }
            Section("Details") {
                LabeledContent("Protocol") {
                    Text(snapshot.host.map { "\($0.protocol.major).\($0.protocol.minor)" } ?? "—")
                }
                LabeledContent("Website") {
                    // `?home` keeps the site on its home page instead of
                    // forwarding a marked browser back to the app.
                    Link("pinomad.si", destination: URL(string: "https://pinomad.si/?home")!)
                }
            }
        }
        .alert("Host name", isPresented: $renaming) {
            TextField("Name", text: $nameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") { saveName() }
        } message: {
            Text("Every paired device shows this host under this name.")
        }
    }

    /// The name every paired device labels this machine by (5.12). The host
    /// cleans what it is sent the way it cleans the machine's own name.
    private func hostNameSection(_ snapshot: ClientSnapshot) -> some View {
        Section {
            Button {
                nameDraft = snapshot.hostName ?? ""
                renaming = true
            } label: {
                LabeledContent("Host name", value: snapshot.hostName ?? "")
            }
            .tint(.primary)
            .disabled(!model.connected)
            if snapshot.settings?.hostNameCustom == true {
                Button("Use the machine's hostname") { model.setHostName(nil) }
                    .disabled(!model.connected)
            }
        } footer: {
            Text("Without a custom name, the machine's hostname is used.")
        }
    }

    private func saveName() {
        let name = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != model.snapshot?.hostName else { return }
        model.setHostName(name)
    }
}

/// The host's release, a newer one if npm has it, and the upgrade in
/// progress — all from the `upgrade` stream, so another device starting or
/// cancelling shows here too.
private struct HostUpgradeSections: View {
    let model: AppModel
    let hostKey: String
    let upgrade: HostUpgradeState
    let mode: AutoUpgradeMode?

    private enum Pending: Equatable {
        case start(UpgradeWhen), cancel, check, setting(AutoUpgradeMode)

        var action: String {
            switch self {
            case .start: "start the upgrade"
            case .cancel: "cancel the upgrade"
            case .check: "check for releases"
            case .setting: "change automatic upgrades"
            }
        }

        var toastKey: String {
            switch self {
            case .start: "upgrade-start"
            case .cancel: "upgrade-cancel"
            case .check: "upgrade-check"
            case .setting: "upgrade-auto"
            }
        }
    }

    @State private var confirming = false
    /// The call sent and not yet answered; one at a time.
    @State private var pending: Pending?

    var body: some View {
        let controls = UpgradeControls(upgrade, connected: model.connected)
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
        } header: {
            Text("Version")
        }
        if case .start? = pending {
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Starting the upgrade…").foregroundStyle(.secondary)
                }
            }
        }
        if let checkError = upgrade.checkError {
            notice(.triangleAlert, tint: .orange, title: "Couldn't check for releases", detail: checkError)
        }
        if controls.showsFailure, let failure = upgrade.failure {
            notice(.circleAlert, tint: .red, title: "Upgrading to pinomad \(failure.version) failed",
                   detail: failure.message, monospaced: true, destructive: true)
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

    /// One call at a time. A failure has no form to stay in (the start
    /// confirmation is a system dialog that's gone by then), so it's a toast
    /// naming the action, replaced by its next failure and cleared on a retry.
    private func act(_ kind: Pending, _ call: @escaping () async throws -> Void) {
        let runtime = model.runtimes[hostKey]
        runtime?.clearToast(key: kind.toastKey)
        pending = kind
        Task {
            do {
                try await call()
            } catch {
                runtime?.showToast(
                    "Couldn't \(kind.action): \(model.describe(error))", level: .error, key: kind.toastKey)
            }
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
        _ icon: ImageResource, tint: Color, title: String, detail: String, monospaced: Bool = false,
        destructive: Bool = false
    ) -> some View {
        Section {
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .foregroundStyle(destructive ? Color.red : Color.primary)
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
