import PinomadCore
import SwiftUI

/// The one account (ADR-0022), opened from the avatar. Signed out, this is
/// the login form; signed in, the hosts the account vouches for and the two
/// ways to sign out. One sheet either way, so signing in lands on the
/// account's hosts instead of closing.
struct AccountView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var pendingAccountPair: AccountHostRow?
    @State private var confirmingSignOutEverywhere = false

    var body: some View {
        NavigationStack {
            if let session = model.accountSession {
                signedIn(session)
            } else {
                AccountLoginView(model: model)
            }
        }
        .onDisappear {
            // Closing the sheet cancels a pairing ask that is still
            // waiting; a late offer must not replace the session the
            // reader went back to.
            model.invalidateAccountPairing()
        }
    }

    private func signedIn(_ session: AccountSession) -> some View {
        List {
            Section {
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
            }

            Section("账号下的宿主") {
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
            }

            Section {
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
            } footer: {
                Text(AccountCopy.signOutExplanation)
            }
        }
        .navigationTitle("账号")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.refreshHostsAndAccount()
        }
        .task {
            await model.accountRefreshHosts()
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
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
}
