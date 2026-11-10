import PinomadChat
import PinomadCore
import SwiftUI

/// One paired machine's page: how this device reaches it (connection,
/// routes) and the ways to let it go, which work disconnected; and, while
/// it is connected, a row for each part of its settings — grouped by what
/// the reader wants to change, like the web's Host settings.
struct MachineSettingsView: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss
    @State private var unpairingHost = false
    @State private var removingHost: PendingAccountHost?

    /// What Settings' search finds the host pages by, the names they took
    /// over included.
    static let keywords = [
        "Providers", "API key", "Subscription", "Login", "Custom endpoint",
        "Models", "Default model", "Thinking",
        "Agents", "Named agents", "Subagents", "MCP", "MCP servers", "Tools",
        "Chats", "Steer", "Follow-up", "Queue", "Archived", "Restore",
        "Devices", "Paired devices", "Pair a device", "Revoke",
        "About", "Host name", "Rename", "Version", "Upgrade", "Update", "Protocol",
    ]

    var body: some View {
        List {
            Section {
                NavigationLink(value: Route.host(hostKey)) {
                    LabeledContent {
                        Text(model.connectionLabel(for: hostKey))
                    } label: {
                        Label("Connection", image: .network)
                    }
                }
            }
            if let host = model.hostRecord(for: hostKey) {
                Section("Routes") {
                    HostRouteList(routes: hostRoutes(host), mode: host.connectionMode ?? .auto)
                }
            }
            if hostKey == model.currentHostKey, let snapshot = model.snapshot {
                settingsSection(snapshot)
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
        .hostTitle(model, hostKey: hostKey, title: title)
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
    }

    /// The host's settings, one page per thing to change; each row's value
    /// is what that page would show first.
    private func settingsSection(_ snapshot: ClientSnapshot) -> some View {
        Section {
            NavigationLink(value: Route.providers(hostKey)) {
                LabeledContent {
                    if let providers = snapshot.providers {
                        let count = providers.providers.filter(\.isConnected).count
                        Text(count == 0 ? "None" : "\(count) connected")
                    }
                } label: {
                    Label("Providers", image: .keyRound)
                }
            }
            NavigationLink(value: Route.hostModels(hostKey)) {
                LabeledContent {
                    Text(defaultModelName(snapshot))
                } label: {
                    Label("Models", image: .sparkles)
                }
            }
            NavigationLink(value: Route.hostAgents(hostKey)) {
                LabeledContent {
                    if let agents = snapshot.agents, !agents.roles.isEmpty {
                        Text("\(agents.roles.count)")
                    }
                } label: {
                    Label("Agents", image: .bot)
                }
            }
            NavigationLink(value: Route.hostChats(hostKey)) {
                Label("Chats", image: .messageCircle)
            }
            NavigationLink(value: Route.hostDevices(hostKey)) {
                LabeledContent {
                    Text("\(snapshot.devices.count)")
                } label: {
                    Label("Devices", image: .smartphone)
                }
            }
            NavigationLink(value: Route.hostAbout(hostKey)) {
                LabeledContent {
                    if let upgrade = snapshot.upgrade {
                        if let available = upgrade.available, upgrade.phase == .idle {
                            Text("\(available.version) available")
                        } else if upgrade.phase != .idle {
                            Text("Upgrading")
                        } else {
                            Text(upgrade.current ?? "Source")
                        }
                    } else if let version = snapshot.host?.version {
                        Text(version)
                    }
                } label: {
                    Label("About", image: .info)
                }
            }
        } header: {
            Text("Host Settings")
        } footer: {
            Text("Shared by every device paired with this host.")
        }
    }

    private func defaultModelName(_ snapshot: ClientSnapshot) -> String {
        guard let ref = snapshot.defaults.model else { return "Pi's default" }
        return summaryOf(models: snapshot.models, model: ref)?.name ?? ref.modelId
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

    /// The same name the row that opened this page showed.
    private var title: String { model.hostPageName(hostKey) }
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
