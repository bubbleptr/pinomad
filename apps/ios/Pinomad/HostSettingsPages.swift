import PinomadChat
import PinomadCore
import SwiftUI

// The pages under one host's settings, grouped by what the reader wants to
// change: Models, Agents, Chats, Devices and About (Providers has its own
// files). Each shows its content while its host is the connected one, and
// names that host with its status dot under the title.

/// One host settings page: its sections while the host is connected, the
/// reason it can't show them otherwise.
struct HostPage<Content: View>: View {
    let model: AppModel
    let hostKey: String
    let title: String
    @ViewBuilder let content: (ClientSnapshot) -> Content

    var body: some View {
        Group {
            if hostKey == model.currentHostKey, let snapshot = model.snapshot {
                List { content(snapshot) }
            } else {
                ContentUnavailableView {
                    Label("Not connected to this host", image: .cloudOff)
                } description: {
                    Text("Its settings show once it connects.")
                }
            }
        }
        .navigationTitle(title)
        .hostTitle(model, hostKey: hostKey, title: title, page: true)
    }
}

/// What a host page says when the host predates the setting.
func tooOld(_ what: String) -> some View {
    Section {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("This host is too old for \(what)")
                Text("Run `pinomad upgrade` on the host.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(.triangleAlert).foregroundStyle(.orange)
        }
    }
}

extension AppModel {
    /// The name a host's settings pages go by: the one its row showed.
    func hostPageName(_ hostKey: String) -> String {
        let host = pairedMachines(stored: hosts, session: sessionHost).first { $0.hostKey == hostKey }
        return hostLabels[hostKey] ?? host.map { $0.name ?? hostOf($0.url) } ?? "Host"
    }
}

extension View {
    /// The bar of a host settings page: the page's name over the host's,
    /// which carries its status dot (green connected, grey otherwise) — or
    /// "Connecting…" while it reconnects past its grace window. On the
    /// host's own page (`page` false) the host's name is the title.
    func hostTitle(_ model: AppModel, hostKey: String, title: String, page: Bool = false) -> some View {
        navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HostTitle(model: model, hostKey: hostKey, title: page ? title : nil)
                }
            }
    }
}

private struct HostTitle: View {
    let model: AppModel
    let hostKey: String
    let title: String?

    var body: some View {
        VStack(spacing: 1) {
            if let title {
                Text(title).font(.headline)
            }
            HStack(spacing: 6) {
                if model.showsReconnecting(hostKey) {
                    ProgressView().controlSize(.mini)
                    Text(model.showsRestarting(hostKey) ? "Host is restarting…" : "Connecting…")
                } else {
                    MachineDot(live: model.isConnected(hostKey))
                    Text(model.hostPageName(hostKey))
                }
            }
            .font(title == nil ? .headline : .caption)
            .foregroundStyle(title == nil ? .primary : .secondary)
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Models

/// The model and thinking level a new conversation starts with when it
/// doesn't pick its own — two settings, two rows.
struct HostModelsView: View {
    let model: AppModel
    let hostKey: String

    var body: some View {
        HostPage(model: model, hostKey: hostKey, title: "Models") { snapshot in
            if let settings = snapshot.settings {
                let ref = snapshot.defaults.model
                let summary = ref.flatMap { summaryOf(models: snapshot.models, model: $0) }
                let levels = summary?.thinkingLevels ?? []
                Section {
                    NavigationLink {
                        DefaultModelPicker(model: model, hostKey: hostKey)
                    } label: {
                        LabeledContent("Default model") {
                            HStack(spacing: 6) {
                                if let ref { ModelLogo(model: ref, size: 14) }
                                Text(ref.map { summary?.name ?? $0.modelId } ?? "Pi's default")
                            }
                        }
                    }
                    .disabled(!model.connected || snapshot.models.isEmpty)
                    // A model that can't reason has nothing to pick here.
                    if levels.count > 1 {
                        Picker("Thinking", selection: Binding(
                            get: { clampLevel(levels: levels, want: snapshot.defaults.thinkingLevel ?? .off) },
                            set: { model.setDefaultThinkingLevel($0) }
                        )) {
                            ForEach(levels, id: \.self) { level in
                                Text(thinkingLevelLabel(level: level) ?? "\(level)").tag(level)
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(!model.connected)
                    }
                } footer: {
                    Text("Used when a new conversation doesn't pick its own model.")
                }
                if settings.custom.contains("defaultModel") || settings.custom.contains("defaultThinkingLevel") {
                    Section {
                        Button("Use Pi's Defaults") {
                            model.setDefaultModel(nil)
                            model.setDefaultThinkingLevel(nil)
                        }
                        .disabled(!model.connected)
                    }
                }
            } else {
                tooOld("settings")
            }
        }
    }
}

/// Every model the host offers, by provider; picking one saves it and
/// goes back.
private struct DefaultModelPicker: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var models: [ModelSummary] {
        hostKey == model.currentHostKey ? model.snapshot?.models ?? [] : []
    }

    var body: some View {
        let shown = filterModels(models: models, query: query)
        let providers = shown.map(\.provider).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        List {
            ForEach(providers, id: \.self) { provider in
                Section(provider) {
                    ForEach(shown.filter { $0.provider == provider }, id: \.self) { summary in
                        let ref = ModelRef(provider: summary.provider, modelId: summary.modelId)
                        Button {
                            model.setDefaultModel(ref)
                            dismiss()
                        } label: {
                            HStack(spacing: 10) {
                                ModelLogo(model: ref, size: 18, reserve: true)
                                Text(summary.name ?? summary.modelId)
                                Spacer()
                                if sameModel(a: ref, b: model.snapshot?.defaults.model) {
                                    Image(.check).foregroundStyle(.tint)
                                }
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
        }
        .disabled(!model.connected)
        .searchable(text: $query, prompt: "Search models")
        .navigationTitle("Default Model")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Agents

/// Named agents (ADR-0023) and the MCP servers the host connects to, both
/// live from their streams. Editing either happens elsewhere.
struct HostAgentsView: View {
    let model: AppModel
    let hostKey: String

    var body: some View {
        HostPage(model: model, hostKey: hostKey, title: "Agents") { snapshot in
            if let agents = snapshot.agents {
                Section {
                    if agents.roles.isEmpty && agents.problems.isEmpty {
                        Text("No named agents yet.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(agents.roles, id: \.name) { role in
                        AgentRoleRow(role: role, models: snapshot.models)
                    }
                    ForEach(agents.problems, id: \.file) { problem in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(problem.file)
                                Spacer()
                                Text("Not loaded").font(.caption).foregroundStyle(.orange)
                            }
                            Text(problem.reason)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("Named Agents")
                } footer: {
                    Text("The model can delegate to these as subagents; mention one with @name. Create and edit them on the web or in the Mac app.")
                }
            } else {
                tooOld("named agents")
            }
            Section("MCP Servers") {
                if let mcp = snapshot.mcp {
                    if mcp.servers.isEmpty && mcp.errors.isEmpty {
                        Text("No servers configured.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(mcp.servers, id: \.name) { server in
                        McpServerRow(server: server)
                    }
                    ForEach(mcp.errors, id: \.self) { error in
                        Label {
                            Text(error).font(.footnote)
                        } icon: {
                            Image(.triangleAlert).foregroundStyle(.orange)
                        }
                    }
                } else {
                    Text("Loading…")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct AgentRoleRow: View {
    let role: AgentRole
    let models: [ModelSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(role.name)
            if !role.description.isEmpty {
                Text(role.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            if !pins.isEmpty || missingModel {
                HStack(spacing: 6) {
                    if !pins.isEmpty {
                        Text(pins.joined(separator: " · "))
                            .foregroundStyle(.secondary)
                    }
                    if missingModel {
                        Text("Model not available").foregroundStyle(.orange)
                    }
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }

    /// `provider/modelId`, split on the first `/`: the role file pins it so.
    private var ref: ModelRef? {
        guard let pinned = role.model, let slash = pinned.firstIndex(of: "/") else { return nil }
        return ModelRef(provider: String(pinned[..<slash]), modelId: String(pinned[pinned.index(after: slash)...]))
    }

    private var summary: ModelSummary? { ref.flatMap { summaryOf(models: models, model: $0) } }

    private var missingModel: Bool { role.model != nil && summary == nil }

    private var pins: [String] {
        [summary?.name ?? role.model, role.thinkingLevel.flatMap { thinkingLevelLabel(level: $0) }].compactMap { $0 }
    }
}

private struct McpServerRow: View {
    let server: McpServer

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(server.name)
                Spacer()
                Text(state)
                    .foregroundStyle(server.state == .failed ? Color.red : Color.secondary)
            }
            if let error = server.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var state: String {
        switch server.state {
        case .connecting: "Connecting"
        case .connected: server.tools == 1 ? "1 tool" : "\(server.tools) tools"
        case .failed: "Failed"
        case .disabled: "Off"
        case .other: "Unknown"
        }
    }
}

// MARK: - Chats

/// How messages typed while the agent works are delivered, and the
/// conversations archived out of the list.
struct HostChatsView: View {
    let model: AppModel
    let hostKey: String

    var body: some View {
        HostPage(model: model, hostKey: hostKey, title: "Chats") { snapshot in
            if let settings = snapshot.settings {
                Section {
                    modePicker("Steer messages", detail: "Delivered at the next turn",
                               value: settings.steeringMode) { model.setSteeringMode($0) }
                    modePicker("Follow-up messages", detail: "Delivered once the agent finishes",
                               value: settings.followUpMode) { model.setFollowUpMode($0) }
                    let custom = ["steeringMode", "followUpMode"].filter(settings.custom.contains)
                    if !custom.isEmpty {
                        Button("Use Pi's Defaults") {
                            if custom.contains("steeringMode") { model.setSteeringMode(nil) }
                            if custom.contains("followUpMode") { model.setFollowUpMode(nil) }
                        }
                        .disabled(!model.connected)
                    }
                } header: {
                    Text("Messages Sent While the Agent Works")
                }
            } else {
                tooOld("settings")
            }
            archivedSection(snapshot.organized.archived)
        }
    }

    private func modePicker(
        _ title: String, detail: String, value: QueueDelivery?, set: @escaping (QueueDelivery) -> Void
    ) -> some View {
        Picker(selection: Binding(get: { value }, set: { if let next = $0, next != value { set(next) } })) {
            Text("One at a time").tag(QueueDelivery?.some(.oneAtATime))
            Text("All at once").tag(QueueDelivery?.some(.all))
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .pickerStyle(.menu)
        .disabled(!model.connected)
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
            Text("Hidden from the list. Restoring one brings back its forks and subagents.")
        }
    }

    /// Archived roots can't be opened from here; they can be restored.
    private func archivedRow(_ entry: ArchivedConversation) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(conversationName(summary: entry.node.summary)).lineLimit(1)
                // The project's name, never its path.
                Text(entry.project.map { $0.name ?? "Project" } ?? "Chat")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if let id = entry.node.summary.id {
                Button("Restore") { model.archive(ConversationRef(hostKey: hostKey, conversationId: id), false) }
                    .buttonStyle(.tactile(.glass))
                    .controlSize(.small)
                    .disabled(!model.connected)
            }
        }
    }
}

// MARK: - Devices

/// The devices paired with this host, a code to pair another (ADR-0022
/// §7), and whether the account's devices may pair without one (§6).
struct HostDevicesView: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss
    @State private var unpairing: DeviceEntry?

    var body: some View {
        HostPage(model: model, hostKey: hostKey, title: "Devices") { snapshot in
            devicesSection(snapshot.devices)
            if let settings = snapshot.settings, model.hostSupports(.acceptAccountDevices) {
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

    private func isThisDevice(_ device: DeviceEntry) -> Bool {
        device.publicKey == model.thisDevicePublicKey
    }

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
        } footer: {
            Text(model.connected
                 ? "The other device scans the QR code or opens the link to pair. Swipe left on a device to unpair it."
                 : "Connect to the host to create a QR code.")
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

