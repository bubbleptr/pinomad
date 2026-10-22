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
                    Text("还没有配对的机器。")
                        .foregroundStyle(.secondary)
                }
            } header: {
                GroupHeader(title: "本机", section: "已配对的机器")
            }
            // Rows are choices, not links — plain text, not tinted.
            .tint(.primary)

            Section("配对一台") {
                PairingSources(model: model)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }

            pushSection

            aboutSection

            if !machines.isEmpty {
                Section {
                    ForEach(machines, id: \.hostKey) { host in
                        machineRow(host)
                    }
                } header: {
                    GroupHeader(title: "机器", section: nil)
                }
            }
        }
        .navigationTitle("设置")
        .alert(
            "忘记 \(forgetting.map(label) ?? "")？",
            isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
            presenting: forgetting
        ) { host in
            Button("取消", role: .cancel) {}
            Button("忘记", role: .destructive) {
                let wasLast = model.hosts.hosts.count == 1
                model.forget(host.hostKey)
                // Nothing left to pick — the pairing page behind has
                // the same ways to pair. Forgetting waits for the
                // unregister call, so decide from the list we had.
                if wasLast { dismiss() }
            }
        } message: { _ in
            Text("这台设备要用新的配对链接才能再连上它。")
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
                    Image(systemName: "checkmark")
                        .foregroundStyle(.blue)
                }
            }
        }
        .swipeActions {
            Button("忘记", role: .destructive) { forgetting = host }
                // The section's plain tint would turn it black.
                .tint(.red)
        }
        .contextMenu {
            Button("忘记", systemImage: "trash", role: .destructive) { forgetting = host }
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
                        Text("连上这台机器后才能查看")
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
                Text("连上一台机器后才能设置推送。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("推送")
        } footer: {
            Text("只带对话标题和事件（「等你回答」「完成」「失败」），标题会经过服务端和 Apple。设置按宿主分别保存。")
        }
    }

    @ViewBuilder
    private func pushControls(_ hostKey: String) -> some View {
        Toggle(isOn: Binding(
            get: { model.pushEnabled(for: hostKey) },
            set: { model.setPushEnabled($0, for: hostKey) }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("推送通知")
                if let name = model.currentHostLabel {
                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!model.pushAvailable(for: hostKey))

        if model.snapshot != nil && !model.hostSupports(.apnsPush) {
            Text("需要把宿主升级到 5.9 或更新才能推送。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if !model.connected {
            Text("连上宿主后登记；现在打开会在下次连接时生效。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if model.pushEnabled(for: hostKey) {
            if model.push.isDenied {
                Text("通知权限被拒绝了，推送不会送达。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                Button("去系统设置打开通知") {
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
                Text("APNs 注册失败：\(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    /// The app's version, and the connected host's — the app's own
    /// protocol version is not exposed by the core.
    private var aboutSection: some View {
        Section("关于") {
            LabeledContent("App 版本", value: appVersion)
            if let info = model.snapshot?.host, let name = model.currentHostLabel {
                LabeledContent(name) {
                    Text("\(info.version ?? "源码") · 协议 \(info.protocol.major).\(info.protocol.minor)")
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
                        Button("完成") { dismiss() }
                    }
                }
        }
    }
}

/// One paired machine's settings: its archived conversations and a pairing
/// code for another device. Needs that machine connected.
struct MachineSettingsView: View {
    let model: AppModel
    let hostKey: String

    var body: some View {
        List {
            if hostKey == model.currentHostKey, let organized = model.snapshot?.organized {
                archivedSection(organized.archived)
                pairingCodeSection
            } else {
                ContentUnavailableView(
                    "没有连着这台机器", systemImage: "bolt.horizontal.circle",
                    description: Text("连上它之后才能查看它的设置。"))
            }
        }
        .navigationTitle(model.hostLabels[hostKey] ?? "机器")
    }

    private func archivedSection(_ archived: [ArchivedConversation]) -> some View {
        Section {
            if archived.isEmpty {
                Text("没有归档的对话。")
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(archived.enumerated()), id: \.offset) { _, entry in
                archivedRow(entry)
            }
        } header: {
            Text("已归档")
        } footer: {
            Text("归档的对话不在列表里显示，恢复后回到列表。")
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
                Button("恢复") { model.archive(conversation: id, false) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(!model.connected)
            }
        }
        .foregroundStyle(.secondary)
    }

    /// Pair another device from the host on screen (ADR-0022 §7).
    private var pairingCodeSection: some View {
        Section {
            Button {
                model.present(.pairingCode)
            } label: {
                Label("给另一台设备配对", systemImage: "qrcode")
            }
            .disabled(!model.connected)

            if !model.connected {
                Text("连上宿主后才能生成二维码。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("配对另一台设备")
        } footer: {
            Text("对方用相机扫码或打开链接即可配对。")
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
            .accessibilityLabel(live ? "已连接" : "未连接")
    }
}
