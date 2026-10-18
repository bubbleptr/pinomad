import PinomadCore
import SwiftUI
import UIKit

/// Where a link comes from when there's no deep link: scan the host's QR
/// code, or paste the link `pinomad pair` printed.
struct PairingSources: View {
    let model: AppModel

    @State private var text = ""
    @State private var invalid = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                model.present(.scanner)
            } label: {
                Label("扫描二维码", systemImage: "qrcode.viewfinder")
                    .labelStyle(.titleAndIcon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            HStack(spacing: 8) {
                TextField("http://…#pair=… 或 pinomad://pair#…", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .onChange(of: text) { _, _ in invalid = false }
                PasteButton(payloadType: String.self) { strings in
                    guard let pasted = strings.first else { return }
                    Task { @MainActor in
                        text = pasted
                        submit()
                    }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.capsule)
            }
            if invalid {
                Text("不是有效的配对链接——粘贴 `pinomad pair` 打印的完整链接。")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button("继续", action: submit)
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .disabled(text.allSatisfy(\.isWhitespace))
        }
    }

    private func submit() {
        guard !text.allSatisfy(\.isWhitespace) else { return }
        // A bad paste says so here; the confirm page is for real links.
        guard model.isPairingLink(text) else {
            invalid = true
            return
        }
        model.offerPairing(text)
        text = ""
    }
}

/// The first-run screen: no host is paired yet.
struct PairingStartView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("连接到宿主")
                    .font(.title2.weight(.semibold))
                Text("在宿主上运行 `pinomad pair`，或在 Web 端打开「设备 → 配对设备」，然后扫码或粘贴链接。")
                    .foregroundStyle(.secondary)
            }
            PairingSources(model: model)
            Divider()
            if let session = model.accountSession {
                Button {
                    model.present(.hosts)
                } label: {
                    Label("账号：\(session.username)", systemImage: "person.crop.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                Text("在宿主列表里配对你账号下的宿主。")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            } else {
                Button {
                    model.present(.account)
                } label: {
                    Label("用账号登录", systemImage: "person.crop.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                Text("登录后不用扫码，就能配对你账号下的宿主。")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            Text("也可以直接打开 pinomad://pair 链接。")
                .font(.footnote)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(20)
    }
}

/// Every link stops here before pairing: says where it would connect, or
/// that it isn't a pairing link at all.
struct PairConfirmView: View {
    let model: AppModel
    let pending: PendingPairing

    @Environment(\.dismiss) private var dismiss
    /// The content's height — the sheet is sized to it.
    @State private var height: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let url = pending.target?.url {
                Text("要和这台宿主配对吗？")
                    .font(.title3.weight(.semibold))
                Text("这台设备会和 \(hostOf(url)) 配对。")
                    .foregroundStyle(.secondary)
                Text(url)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 10))
                if model.phase == .connected, let current = model.currentHostLabel {
                    Text("会断开当前的 \(current)。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    Button { dismiss() } label: {
                        Text("取消").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        model.pair(link: pending.link)
                        dismiss()
                    } label: {
                        Text("配对").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
                .padding(.top, 8)
            } else {
                Text("这个配对链接无效")
                    .font(.title3.weight(.semibold))
                Text("在宿主上运行 `pinomad pair`，或在「设备 → 配对设备」里生成新的链接。")
                    .foregroundStyle(.secondary)
                Button { dismiss() } label: {
                    Text("好").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .padding(.top, 8)
            }
        }
        .padding(24)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .presentationDetents([.height(height)])
    }
}

/// Every paired host: switch, forget (after a confirm), or pair another.
struct HostsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var forgetting: HostRecord?
    @State private var pendingAccountPair: AccountHostRow?
    @State private var confirmingSignOutEverywhere = false

    var body: some View {
        NavigationStack {
            List {
                accountSection
                if !model.hosts.hosts.isEmpty {
                    Section("已配对") {
                        ForEach(model.hosts.hosts, id: \.hostKey) { host in
                            row(host)
                        }
                    }
                    // Rows are choices, not links — plain text, not tinted.
                    .tint(.primary)
                }
                if let hostKey = model.currentHostKey {
                    pushSection(hostKey)
                }
                Section("再配对一台") {
                    PairingSources(model: model)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
            }
            .navigationTitle("宿主")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await model.refreshHostsAndAccount()
            }
            .task {
                if model.accountSession != nil {
                    await model.accountRefreshHosts()
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
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
            .alert(
                "要和这台宿主配对吗？",
                isPresented: Binding(
                    get: { pendingAccountPair != nil },
                    set: { if !$0 { pendingAccountPair = nil } })
            ) {
                Button("取消", role: .cancel) { pendingAccountPair = nil }
                Button("配对") {
                    let row = pendingAccountPair
                    pendingAccountPair = nil
                    if let row { startAccountPair(row) }
                }
            } message: {
                Text("会断开当前的 \(model.currentHostLabel ?? "宿主")，但不会忘记它。")
            }
            .alert("在所有设备上退出？", isPresented: $confirmingSignOutEverywhere) {
                Button("取消", role: .cancel) {}
                Button("退出", role: .destructive) {
                    Task { await model.accountSignOut(everywhere: true) }
                }
            } message: {
                Text("所有设备上的账号会话都会失效；已配对的宿主不受影响，需要重新登录。")
            }
        }
    }

    private func label(_ host: HostRecord) -> String {
        model.hostLabels[host.hostKey] ?? host.url
    }

    /// The one account and the hosts it vouches for. Signed out, this is a
    /// single sign-in row; signed in, it is the account host list plus the
    /// two ways to sign out.
    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let session = model.accountSession {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.username)
                    Text(hostOf(session.serverOrigin))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let notice = model.accountNotice {
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                if model.accountRefreshing && model.accountRows.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在读取账号宿主…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else if model.accountRows.isEmpty, model.accountHostsError == nil {
                    Text("账号下还没有宿主。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.accountRows) { row in
                        accountRow(row)
                    }
                }

                if let error = model.accountHostsError ?? model.accountError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if let warning = model.accountSignOutWarning {
                    Text(warning)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                Button("退出登录", role: .destructive) {
                    Task { await model.accountSignOut(everywhere: false) }
                }
                .disabled(model.accountBusy)

                Button("在所有设备上退出", role: .destructive) {
                    confirmingSignOutEverywhere = true
                }
                .disabled(model.accountBusy)
            } else {
                Button {
                    model.present(.account)
                } label: {
                    Label("登录账号", systemImage: "person.crop.circle")
                }

                if let notice = model.accountNotice {
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                if let warning = model.accountSignOutWarning {
                    Text(warning)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
        } header: {
            Text("账号")
        } footer: {
            if model.accountSession != nil {
                Text(AccountCopy.signOutExplanation)
            }
        }
    }

    @ViewBuilder
    private func accountRow(_ row: AccountHostRow) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name)
                HStack(spacing: 5) {
                    Circle()
                        .fill(row.online ? Color.green : Color.secondary)
                        .frame(width: 6, height: 6)
                    Text(row.online ? "在线" : "离线")
                    Text("·")
                    Text(statusLabel(row.status))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if row.status != .paired, let reason = row.pairingReason {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            accountAction(row)
        }
    }

    @ViewBuilder
    private func accountAction(_ row: AccountHostRow) -> some View {
        switch row.action {
        case .connect(let hostKey):
            if hostKey == model.currentHostKey && model.connected {
                Text("已连接")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Button("连接") {
                    model.switchHost(hostKey)
                    dismiss()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        case .pair, .rePair:
            if model.accountPairingHostId == row.hostId {
                ProgressView().controlSize(.small)
            } else {
                Button(row.action == .rePair ? "重新配对" : "配对") {
                    requestAccountPair(row)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!row.pairable || model.accountBusy)
            }
        }
    }

    private func statusLabel(_ status: AccountHostRowStatus) -> String {
        switch status {
        case .paired: "已配对"
        case .unpaired: "未配对"
        case .keyChanged: "公钥变了"
        case .rejected: "被宿主拒绝"
        }
    }

    private func requestAccountPair(_ row: AccountHostRow) {
        if model.connected, model.currentHostKey != row.storedHostKey {
            pendingAccountPair = row
        } else {
            startAccountPair(row)
        }
    }

    private func startAccountPair(_ row: AccountHostRow) {
        Task {
            if await model.pairViaAccount(hostId: row.hostId) {
                dismiss()
            }
        }
    }

    /// The switch for the host on screen. The preference is per host; the
    /// registration itself needs that host connected and at least 5.9.
    private func pushSection(_ hostKey: String) -> some View {
        Section {
            Toggle("推送通知", isOn: Binding(
                get: { model.pushEnabled(for: hostKey) },
                set: { model.setPushEnabled($0, for: hostKey) }
            ))
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
        } header: {
            Text("推送")
        } footer: {
            Text("只带对话标题和事件（「等你回答」「完成」「失败」），标题会经过服务端和 Apple。设置按宿主分别保存。")
        }
    }

    private func row(_ host: HostRecord) -> some View {
        Button {
            model.switchHost(host.hostKey)
            dismiss()
        } label: {
            HStack {
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
}
