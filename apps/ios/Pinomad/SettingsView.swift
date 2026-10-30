import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

/// This device's settings: its paired hosts — each opening its own
/// settings — and a way to add one, the account, push and about. Pushed
/// from the list; needs no connection.
struct SettingsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var forgetting: HostRecord?

    var body: some View {
        List {
            Section("Hosts") {
                ForEach(machines, id: \.hostKey) { host in
                    pairedRow(host)
                }
                if machines.isEmpty {
                    Text("No paired hosts yet.")
                        .foregroundStyle(.secondary)
                }
                NavigationLink(value: Route.addHost) {
                    Label("Add Host", image: .plus)
                }
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
                if model.accountRecord == nil {
                    Text("Sign in to pair the hosts on your account.")
                }
            }

            pushSection

            aboutSection
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

    private var machines: [HostRecord] { model.machines }

    private func label(_ host: HostRecord) -> String {
        model.machineLabel(host.hostKey)
    }

    /// Opens the machine's own settings; every machine is live, so there is
    /// nothing to switch (#429).
    private func pairedRow(_ host: HostRecord) -> some View {
        NavigationLink(value: Route.machine(host.hostKey)) {
            HStack(spacing: 10) {
                MachineDot(live: model.isConnected(host.hostKey))
                VStack(alignment: .leading, spacing: 2) {
                    Text(label(host))
                        .foregroundStyle(.primary)
                    Text(model.connectionLabel(for: host.hostKey))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .swipeActions {
            Button("Forget", role: .destructive) { forgetting = host }
                // The row's plain tint would turn it black.
                .tint(.red)
        }
        .contextMenu {
            Button("Forget", image: .trash2, role: .destructive) { forgetting = host }
        }
    }

    /// The app-level switch. Every connected host registers or clears; a host
    /// that is still connecting catches up when it becomes ready.
    @ViewBuilder
    private var pushSection: some View {
        Section {
            pushControls
        } header: {
            Text("Notifications")
        } footer: {
            Text("Notifications carry only the conversation title and the event (\"Waiting for your answer\", \"Finished\", \"Failed\"); titles pass through the server and Apple.")
        }
    }

    @ViewBuilder
    private var pushControls: some View {
        Toggle("Push notifications", isOn: Binding(
            get: { model.pushEnabled },
            set: { model.setPushEnabled($0) }
        ))

        let outdated = machines.filter {
            model.isConnected($0.hostKey) && !model.hostSupports(.apnsPush, on: $0.hostKey)
        }
        if !outdated.isEmpty {
            Text("Update \(ListFormatter.localizedString(byJoining: outdated.map(label))) to 5.9 or later to get notifications.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if model.pushEnabled {
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

    /// The app's version, and each machine's that has answered — the app's
    /// own protocol version is not exposed by the core.
    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App version", value: appVersion)
            ForEach(machines, id: \.hostKey) { host in
                if let info = model.runtimes[host.hostKey]?.snapshot?.host {
                    LabeledContent(label(host)) {
                        Text("\(info.version ?? "source build") · protocol \(info.protocol.major).\(info.protocol.minor)")
                    }
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
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
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
        .environment(\.popToProviders, PopToProvidersAction(stack: "settings") { path.popToProviders() })
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
            Section {
                NavigationLink(value: Route.host(hostKey)) {
                    LabeledContent {
                        Text(model.connectionLabel(for: hostKey))
                    } label: {
                        Label("Connection", image: .info)
                    }
                }
            }
            if hostKey == model.currentHostKey, let snapshot = model.snapshot {
                if snapshot.settings != nil && model.hostSupports(.hostName) {
                    hostNameSection(snapshot)
                }
                providersSection(snapshot.providers)
                devicesSection(snapshot.devices)
                if let settings = snapshot.settings, model.hostSupports(.acceptAccountDevices) {
                    accountDevicesSection(settings)
                }
                archivedSection(snapshot.organized.archived)
            } else {
                ContentUnavailableView {
                    Label("Not connected to this host", image: .cloudOff)
                } description: {
                    Text("Its settings show once it connects.")
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
                Button("Restore") { model.archive(ConversationRef(hostKey: hostKey, conversationId: id), false) }
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

    /// Where the host gets its models from (ADR-0031): logins and custom
    /// endpoints, kept on the host and shared by every paired device.
    private func providersSection(_ providers: HostProviders?) -> some View {
        Section {
            NavigationLink(value: Route.providers(hostKey)) {
                LabeledContent {
                    if let providers {
                        let count = providers.providers.filter(\.isConnected).count
                        Text(count == 0 ? "None" : "\(count) connected")
                    }
                } label: {
                    Label("Providers", image: .keyRound)
                }
            }
        } footer: {
            Text("Subscriptions, API keys and custom endpoints this host reaches models through.")
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

/// Green while this machine is connected, grey otherwise.
private struct MachineDot: View {
    let live: Bool

    var body: some View {
        Circle()
            .fill(live ? Color.green : Color.secondary.opacity(0.5))
            .frame(width: 8, height: 8)
            .accessibilityLabel(live ? "Connected" : "Not connected")
    }
}
