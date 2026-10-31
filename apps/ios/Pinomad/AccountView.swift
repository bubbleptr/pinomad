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

            Section("Hosts on Your Account") {
                if model.accountRefreshing && model.accountRows.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading hosts…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else if model.accountRows.isEmpty, model.accountHostsError == nil {
                    Text("No hosts on this account yet.")
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

                Button("Sign out", role: .destructive) {
                    Task { await model.accountSignOut(everywhere: false) }
                }
                .disabled(model.accountBusy)

                Button("Sign out everywhere", role: .destructive) {
                    confirmingSignOutEverywhere = true
                }
                .disabled(model.accountBusy)
            } footer: {
                Text(AccountCopy.signOutExplanation)
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.refreshHostsAndAccount()
        }
        .task {
            await model.accountRefreshHosts()
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .alert(
            "Pair with this host?",
            isPresented: Binding(
                get: { pendingAccountPair != nil },
                set: { if !$0 { pendingAccountPair = nil } })
        ) {
            Button("Cancel", role: .cancel) { pendingAccountPair = nil }
            Button("Pair") {
                let row = pendingAccountPair
                pendingAccountPair = nil
                if let row { startAccountPair(row) }
            }
        } message: {
            Text("This disconnects \(model.currentHostLabel ?? "the current host") but doesn't forget it.")
        }
        .alert("Sign out everywhere?", isPresented: $confirmingSignOutEverywhere) {
            Button("Cancel", role: .cancel) {}
            Button("Sign out", role: .destructive) {
                Task { await model.accountSignOut(everywhere: true) }
            }
        } message: {
            Text("Your account is signed out on every device, and each one needs to sign in again before it gets notifications. Paired hosts stay paired.")
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
                    Text(row.online ? "Online" : "Offline")
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
            // Already paired, so already connecting with the rest (#429).
            Text(model.connectionLabel(for: hostKey))
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .pair, .rePair:
            if model.accountPairingHostId == row.hostId {
                ProgressView().controlSize(.small)
            } else {
                Button(row.action == .rePair ? "Pair again" : "Pair") {
                    requestAccountPair(row)
                }
                .buttonStyle(.tactile(.glass))
                .controlSize(.small)
                .disabled(!row.pairable || model.accountBusy)
            }
        }
    }

    private func statusLabel(_ status: AccountHostRowStatus) -> String {
        switch status {
        case .paired: "Paired"
        case .unpaired: "Not paired"
        case .keyChanged: "Key changed"
        case .rejected: "Refused by host"
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
