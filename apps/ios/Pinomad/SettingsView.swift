import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

/// This device's settings: the account's pages (or the way to sign in),
/// every host this device can use — each paired one opening its own page —
/// push and about. Pushed from the list; needs no connection.
struct SettingsView: View {
    let model: AppModel

    @Environment(\.openURL) private var openURL
    @State private var asking: AccountHostRow?
    @State private var removing: PendingAccountHost?
    @State private var query = ""
    @AppStorage(Appearance.storageKey) private var appearance = Appearance.system

    var body: some View {
        List {
            if shows(accountKeywords) { accountSection }

            if shows(hostKeywords) {
                HostsSections(model: model, asking: $asking, removing: $removing)
            }

            if shows(appearanceKeywords) { appearanceSection }

            if shows(["Notifications", "Push", "Alerts"]) { pushSection }

            if shows(["About", "Version", "Protocol"] + machines.map(label)) { aboutSection }

            if !query.isEmpty, !shows(accountKeywords + hostKeywords + appearanceKeywords + ["Notifications", "Push", "Alerts", "About", "Version", "Protocol"]) {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationTitle("Settings")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search settings")
        .hostsActions(model: model, asking: $asking, removing: $removing)
    }

    /// Whether a section answers the search: its name or one of its words.
    private func shows(_ keywords: [String]) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || keywords.contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    private var accountKeywords: [String] {
        ["Account", "Sign in", "Sign out", "Email", "Password", "Sign-in methods", "Signed-in devices",
         "Delete account", "GitHub", "Google", "Apple"]
            + [model.accountSession?.displayName].compactMap { $0 }
    }

    private var hostKeywords: [String] {
        ["Hosts", "Add Host", "Pair", "Unpair", "Connection", "Routes"]
            + machines.map(label) + model.accountRows.map(\.name)
    }

    private let appearanceKeywords = ["Appearance", "Theme", "Light", "Dark", "Dark mode", "System"]

    private var machines: [HostRecord] { model.machines }

    private func label(_ host: HostRecord) -> String {
        model.machineLabel(host.hostKey)
    }

    /// Signed in, the account's page; signed out, only the way in, which
    /// stays a sheet of its own.
    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let session = model.accountSession, !model.accountNeedsEmail {
                NavigationLink(value: Route.account) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.displayName)
                            Text(hostOf(session.serverOrigin))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(.userRound)
                    }
                }
            } else {
                Button {
                    model.present(.account)
                } label: {
                    Label(model.accountSession == nil ? "Sign In" : "Finish Signing In", image: .userRound)
                }
                .tint(.primary)
            }
        } header: {
            Text("Account")
        } footer: {
            if model.accountSession == nil {
                Text("Sign in to pair the hosts on your account.")
            }
        }
    }

    private var appearanceSection: some View {
        Section("Appearance") {
            Picker("Appearance", selection: $appearance) {
                ForEach(Appearance.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
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

            if model.accountSession == nil {
                Text("Sign in to the account your hosts joined. The server only delivers notifications to devices signed in to the same account.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let error = model.serverPushError {
                Text("Couldn't register this device with the server: \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
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
        // This stack isn't navPath; the focus must follow it all the same.
        .onChange(of: path) { _, path in model.followVisiblePage(path.last) }
        .onDisappear { model.followVisiblePage(model.navPath.last) }
    }
}

/// One paired machine's page: how this device reaches it (connection,
/// routes) and the ways to let it go, which work disconnected; and, while
/// it is connected, its name, providers, the devices paired with it and its
/// archived conversations.
struct MachineSettingsView: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss
    @State private var renaming = false
    @State private var nameDraft = ""
    @State private var unpairing: DeviceEntry?
    @State private var unpairingHost = false
    @State private var removingHost: PendingAccountHost?

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
            if let host = model.hostRecord(for: hostKey) {
                Section("Routes") {
                    HostRouteList(routes: hostRoutes(host), mode: host.connectionMode ?? .auto)
                }
            }
            if hostKey == model.currentHostKey, let snapshot = model.snapshot {
                if snapshot.settings != nil && model.hostSupports(.hostName) {
                    hostNameSection(snapshot)
                }
                providersSection(snapshot.providers)
                upgradeSection(snapshot.upgrade)
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
            letGoSection
        }
        .navigationTitle(title)
        // Unpaired or taken off the account: nothing left to show.
        .onChange(of: model.hostRecord(for: hostKey) == nil) { _, gone in
            if gone { dismiss() }
        }
        .alert("Unpair \(title)?", isPresented: $unpairingHost) {
            Button("Cancel", role: .cancel) {}
            Button("Unpair", role: .destructive) {
                model.unpair(hostKey)
                dismiss()
            }
        } message: {
            Text(model.unpairMessage(hostKey))
        }
        .sheet(item: $removingHost) { host in
            FormSheet {
                RemoveHostView(
                    model: model, host: host,
                    server: model.accountSession.map { hostOf($0.serverOrigin) } ?? "the server")
            }
        }
        .alert("Host name", isPresented: $renaming) {
            TextField("Name", text: $nameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") { saveName() }
        } message: {
            Text("Every paired device shows this host under this name.")
        }
        .alert(
            unpairing.map { isThisDevice($0) ? "Unpair this device?" : "Unpair \($0.name)?" } ?? "",
            isPresented: Binding(get: { unpairing != nil }, set: { if !$0 { unpairing = nil } }),
            presenting: unpairing
        ) { device in
            Button("Cancel", role: .cancel) {}
            Button("Unpair", role: .destructive) {
                if isThisDevice(device) {
                    // This device's own pairing ends at both ends, or the
                    // next connection would only find the host refusing it.
                    model.unpair(hostKey)
                    dismiss()
                } else {
                    model.revoke(device: device.publicKey)
                }
            }
        } message: { device in
            if isThisDevice(device) {
                Text("This host will stop accepting this device, and this device forgets the host. Connecting again needs a new pairing link.")
            } else {
                Text("This host will stop accepting it. It can pair again with a new pairing link.")
            }
        }
    }

    /// Unpair here, or take the host off the account for every device. Both
    /// confirm first.
    private var letGoSection: some View {
        Section {
            Button("Unpair") { unpairingHost = true }
            if let row = accountRow {
                Button("Remove from Account") { removingHost = row.pending }
                    .disabled(model.accountBusy)
            }
        } footer: {
            if accountRow != nil {
                Text("Unpairing forgets this host on this iPhone. Removing it from your account disconnects it from the server for every device.")
            }
        }
    }

    /// This host's line in the signed-in account's list, if it is on it.
    private var accountRow: AccountHostRow? {
        guard model.accountSession != nil else { return nil }
        return model.accountRows.first { $0.storedHostKey == hostKey }
    }

    private func isThisDevice(_ device: DeviceEntry) -> Bool {
        device.publicKey == model.thisDevicePublicKey
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
                Text(conversationName(summary: entry.node.summary)).lineLimit(1)
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

    /// The host's release and upgrading it from here (ADR-0043).
    private func upgradeSection(_ upgrade: HostUpgradeState?) -> some View {
        Section {
            NavigationLink(value: Route.upgrade(hostKey)) {
                LabeledContent {
                    if let upgrade {
                        if let available = upgrade.available, upgrade.phase == .idle {
                            Text("\(available.version) available")
                        } else if upgrade.phase != .idle {
                            Text("Upgrading")
                        } else {
                            Text(upgrade.current ?? "Source")
                        }
                    }
                } label: {
                    Label("Upgrade", image: .arrowBigUpDash)
                }
            }
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
                DeviceRow(device: device, isThisDevice: isThisDevice(device))
                    .swipeActions {
                        Button("Unpair", role: .destructive) { unpairing = device }
                            .tint(.red)
                            .disabled(!model.connected)
                    }
                    .contextMenu {
                        Button("Unpair", image: .circleX, role: .destructive) { unpairing = device }
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
                 ? "The other device scans the QR code or opens the link to pair. Swipe left on a device to unpair it."
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

/// One machine's routes: each network or server this device can reach it
/// over (#502). Which one carries the connection is the status line's job —
/// the stored set can change under a live socket.
private struct HostRouteList: View {
    let routes: [HostRoute]
    let mode: HostConnectionMode

    var body: some View {
        if routes.isEmpty {
            Text("No published address")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(routes) { route in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(route.label)
                            .foregroundStyle(.secondary)
                            .frame(width: 92, alignment: .leading)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(route.address)
                                .monospaced()
                                .foregroundStyle(.secondary)
                            if !route.isOn {
                                Text("Off in \(mode.label)")
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .font(.caption)
                    .opacity(route.isOn ? 1 : 0.6)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
