import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

/// Settings in two groups: this device (its paired machines, pairing
/// another, push, about) and one row per paired machine, leading to that
/// machine's own settings. Pushed from the list; needs no connection.
struct SettingsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var forgetting: HostRecord?

    var body: some View {
        List {
            Section {
                ForEach(machines, id: \.hostKey) { host in
                    pairedRow(host)
                }
                if machines.isEmpty {
                    Text("No paired hosts yet.")
                        .foregroundStyle(.secondary)
                }
            } header: {
                GroupHeader(title: "This Device", section: "Paired Hosts")
            }
            // Rows are choices, not links — plain text, not tinted.
            .tint(.primary)

            Section("Pair a Host") {
                // On the section's card: a list row clips the glass
                // controls' shadow square, which reads as a smear on the
                // bare grouped background but not inside the card.
                PairingSources(model: model)
                    .padding(.vertical, 6)
            }

            // The failure and connecting pages reach the account only from
            // here: the avatar lives on the list, the first-run page only
            // shows before anything is paired.
            Section {
                Button {
                    model.present(.account)
                } label: {
                    Label(model.accountRecord.map { "Account: \($0.username)" } ?? "Sign in",
                          image: .userRound)
                }
                .tint(.primary)
            } header: {
                Text("Account")
            } footer: {
                Text("Sign in to pair the hosts on your account.")
            }

            pushSection

            aboutSection

            if !machines.isEmpty {
                Section {
                    ForEach(machines, id: \.hostKey) { host in
                        machineRow(host)
                    }
                } header: {
                    GroupHeader(title: "Hosts", section: nil)
                }
            }
        }
        .navigationTitle("Settings")
        .alert(
            "Forget \(forgetting.map(label) ?? "this host")?",
            isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
            presenting: forgetting
        ) { host in
            Button("Cancel", role: .cancel) {}
            Button("Forget", role: .destructive) {
                let wasLast = machines.count == 1
                model.forget(host.hostKey)
                // Nothing left to pick — the pairing page behind has
                // the same ways to pair. Forgetting waits for the
                // unregister call, so decide from the list we had.
                if wasLast { dismiss() }
            }
        } message: { _ in
            Text("This device will need a new pairing link to reconnect to it.")
        }
    }

    private var machines: [HostRecord] {
        pairedMachines(stored: model.hosts, session: model.sessionHost)
    }

    private func label(_ host: HostRecord) -> String {
        model.hostLabels[host.hostKey] ?? host.name ?? hostOf(host.url)
    }

    private func isLive(_ host: HostRecord) -> Bool {
        host.hostKey == model.currentHostKey && model.connected
    }

    /// Tap to switch — the only way to until the list groups by machine.
    private func pairedRow(_ host: HostRecord) -> some View {
        Button {
            guard host.hostKey != model.currentHostKey || model.phase != .connected else { return }
            model.switchHost(host.hostKey)
            // Switching resets the stack already; in the sheet this closes it.
            dismiss()
        } label: {
            HStack(spacing: 10) {
                MachineDot(live: isLive(host))
                VStack(alignment: .leading, spacing: 2) {
                    Text(label(host))
                        .foregroundStyle(.primary)
                    Text(host.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if host.hostKey == model.currentHostKey {
                    Image(.check)
                        .foregroundStyle(.blue)
                }
            }
        }
        .swipeActions {
            Button("Forget", role: .destructive) { forgetting = host }
                // The section's plain tint would turn it black.
                .tint(.red)
        }
        .contextMenu {
            Button("Forget", image: .trash2, role: .destructive) { forgetting = host }
        }
    }

    /// Only the connected machine's page opens; the others need a
    /// connection to read anything from.
    private func machineRow(_ host: HostRecord) -> some View {
        let live = isLive(host)
        return NavigationLink(value: Route.machine(host.hostKey)) {
            HStack(spacing: 10) {
                MachineDot(live: live)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label(host))
                    if !live {
                        Text("Connect to this host to view it")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .disabled(!live)
    }

    /// The switch for the host on screen. The preference is per host; the
    /// registration itself needs that host connected and at least 5.9.
    @ViewBuilder
    private var pushSection: some View {
        Section {
            if let hostKey = model.currentHostKey {
                pushControls(hostKey)
            } else {
                Text("Connect to a host to set up notifications.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Notifications carry only the conversation title and the event (\"Waiting for your answer\", \"Finished\", \"Failed\"); titles pass through the server and Apple. Saved separately for each host.")
        }
    }

    @ViewBuilder
    private func pushControls(_ hostKey: String) -> some View {
        Toggle(isOn: Binding(
            get: { model.pushEnabled(for: hostKey) },
            set: { model.setPushEnabled($0, for: hostKey) }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Push notifications")
                if let name = model.currentHostLabel {
                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!model.pushAvailable(for: hostKey))

        if model.snapshot != nil && !model.hostSupports(.apnsPush) {
            Text("Update the host to 5.9 or later to get notifications.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if !model.connected {
            Text("Registers once the host is connected. Turning it on now takes effect on the next connection.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if model.pushEnabled(for: hostKey) {
            if model.push.isDenied {
                Text("Notification permission is denied, so notifications won't arrive.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                Button("Turn on notifications in Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                }
                .font(.footnote)
            }

            if let error = model.pushError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if let error = model.push.registrationError {
                Text("APNs registration failed: \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    /// The app's version, and the connected host's — the app's own
    /// protocol version is not exposed by the core.
    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App version", value: appVersion)
            if let info = model.snapshot?.host, let name = model.currentHostLabel {
                LabeledContent(name) {
                    Text("\(info.version ?? "source build") · protocol \(info.protocol.major).\(info.protocol.minor)")
                }
            }
        }
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        guard let build = info?["CFBundleVersion"] as? String else { return version }
        return "\(version) (\(build))"
    }
}

/// Settings opened as a sheet — from the connecting and failure pages,
/// which have no list to push it from.
struct SettingsSheet: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SettingsView(model: model)
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: Route.self) { route in
                    RouteDestination(model: model, route: route)
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// One paired machine's settings: its name, the devices paired with it,
/// and its archived conversations. Needs that machine connected.
struct MachineSettingsView: View {
    let model: AppModel
    let hostKey: String

    @State private var renaming = false
    @State private var nameDraft = ""
    @State private var revoking: DeviceEntry?

    var body: some View {
        List {
            if hostKey == model.currentHostKey, let snapshot = model.snapshot {
                if snapshot.settings != nil && model.hostSupports(.hostName) {
                    hostNameSection(snapshot)
                }
                devicesSection(snapshot.devices)
                if let settings = snapshot.settings, model.hostSupports(.acceptAccountDevices) {
                    accountDevicesSection(settings)
                }
                archivedSection(snapshot.organized.archived)
            } else {
                ContentUnavailableView {
                    Label("Not connected to this host", image: .cloudOff)
                } description: {
                    Text("Connect to it to see its settings.")
                }
            }
        }
        .navigationTitle(title)
        .alert("Host name", isPresented: $renaming) {
            TextField("Name", text: $nameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") { saveName() }
        } message: {
            Text("Every paired device shows this host under this name.")
        }
        .alert(
            revoking.map { "Revoke \($0.name)?" } ?? "",
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            presenting: revoking
        ) { device in
            Button("Cancel", role: .cancel) {}
            Button("Revoke", role: .destructive) { model.revoke(device: device.publicKey) }
        } message: { device in
            if device.publicKey == model.thisDevicePublicKey {
                Text("This is this device. Revoking disconnects it right away, and it needs a new pairing link to reconnect.")
            } else {
                Text("It disconnects and needs a new pairing link to reconnect to this host.")
            }
        }
    }

    /// The same name the row that opened this page showed.
    private var title: String {
        let host = pairedMachines(stored: model.hosts, session: model.sessionHost)
            .first { $0.hostKey == hostKey }
        return model.hostLabels[hostKey] ?? host.map { $0.name ?? hostOf($0.url) } ?? "Host"
    }

    private func archivedSection(_ archived: [ArchivedConversation]) -> some View {
        Section {
            if archived.isEmpty {
                Text("No archived conversations.")
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(archived.enumerated()), id: \.offset) { _, entry in
                archivedRow(entry)
            }
        } header: {
            Text("Archived")
        } footer: {
            Text("Archived conversations are hidden from the list. Restore one to bring it back.")
        }
    }

    /// Archived roots can't be opened from here; they can be restored.
    private func archivedRow(_ entry: ArchivedConversation) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName(summary: entry.node.summary)).lineLimit(1)
                if let name = entry.project?.name ?? entry.project?.path {
                    Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if let id = entry.node.summary.id {
                Button("Restore") { model.archive(conversation: id, false) }
                    .buttonStyle(.tactile(.glass))
                    .controlSize(.small)
                    .disabled(!model.connected)
            }
        }
        .foregroundStyle(.secondary)
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

    /// The devices paired with this machine, and a code to pair another
    /// (ADR-0022 §7).
    private func devicesSection(_ devices: [DeviceEntry]) -> some View {
        Section {
            if devices.isEmpty {
                Text("No paired devices yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(devices, id: \.publicKey) { device in
                DeviceRow(device: device, isThisDevice: device.publicKey == model.thisDevicePublicKey)
                    .swipeActions {
                        Button("Revoke", role: .destructive) { revoking = device }
                            .tint(.red)
                            .disabled(!model.connected)
                    }
                    .contextMenu {
                        Button("Revoke", image: .circleX, role: .destructive) { revoking = device }
                            .disabled(!model.connected)
                    }
            }
            Button {
                model.present(.pairingCode)
            } label: {
                Label("Pair a device", image: .qrCode)
            }
            .disabled(!model.connected)
        } header: {
            Text("Devices")
        } footer: {
            Text(model.connected
                 ? "The other device scans the QR code or opens the link to pair. Swipe left on a device to revoke it."
                 : "Connect to the host to create a QR code.")
        }
    }

    /// Whether the server this machine joined may vouch for new devices
    /// (ADR-0022 §6, 5.8).
    private func accountDevicesSection(_ settings: HostSettingsState) -> some View {
        Section {
            Toggle("Accept devices from your account", isOn: Binding(
                get: { settings.acceptAccountDevices },
                set: { model.setAcceptAccountDevices($0) }
            ))
            .disabled(!model.connected)
        } footer: {
            Text("Devices signed in to the server this host joined can pair without a QR code. Turn this off to allow QR pairing only.")
        }
    }
}

/// A paired device: its name, when and how it paired, and a badge on this
/// one.
private struct DeviceRow: View {
    let device: DeviceEntry
    let isThisDevice: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .lineLimit(1)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if isThisDevice {
                Text("This device")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: .capsule)
            }
        }
    }

    /// Date and minute — two devices paired the same day stay apart.
    private var detail: String {
        let at = Date(timeIntervalSince1970: device.pairedAt / 1000)
            .formatted(date: .numeric, time: .shortened)
        switch device.source {
        case .qr: return "\(at) via QR code"
        case .local: return "\(at) on this machine"
        case .account: return "\(at) via account"
        case nil: return "Paired \(at)"
        }
    }
}

/// A group's name above its first section's own header, so the page reads
/// as two groups rather than a run of equal sections.
private struct GroupHeader: View {
    let title: String
    let section: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // `Color.primary`, not `.primary`: the header's own style is
            // the secondary level, which `.primary` would resolve against.
            Text(title)
                .font(.title2.weight(.bold))
                .foregroundStyle(Color.primary)
            if let section {
                Text(section)
            }
        }
        .textCase(nil)
    }
}

/// Green while the session is connected to this machine, grey otherwise.
private struct MachineDot: View {
    let live: Bool

    var body: some View {
        Circle()
            .fill(live ? Color.green : Color.secondary.opacity(0.5))
            .frame(width: 8, height: 8)
            .accessibilityLabel(live ? "Connected" : "Not connected")
    }
}
