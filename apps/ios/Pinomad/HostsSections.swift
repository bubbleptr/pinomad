import PinomadCore
import SwiftUI

/// Settings → Hosts: every machine this device can use. The ones paired
/// here come first, each opening its own page; signed in, the account's
/// others follow with Pair. A row offers at most one action — Pair again
/// when the account says this device was refused or the host's key
/// changed — and the rest sits on the host's page or in the row's swipe
/// and context menu. Belongs to this device, so it works with every
/// connection down. Pairs with `hostsActions`, which holds the alerts and
/// sheets the rows open.
struct HostsSections: View {
    let model: AppModel
    @Binding var asking: AccountHostRow?
    @Binding var removing: PendingAccountHost?

    var body: some View {
        let split = model.hostsPartition
        let signedIn = model.accountSession != nil
        Section {
            ForEach(model.machines, id: \.hostKey) { host in
                PairedHostRow(model: model, host: host, issue: split.issues[host.hostKey], pair: request)
            }
            if model.machines.isEmpty {
                Text("No paired hosts yet.")
                    .foregroundStyle(.secondary)
            }
            NavigationLink(value: Route.addHost) {
                Label("Add Host", image: .plus)
            }
        } header: {
            Text(signedIn && !split.notPairedHere.isEmpty ? "Paired with This iPhone" : "Hosts")
        }

        if signedIn {
            // A failed Pair is said on its row; this is the list's own load.
            if let error = model.accountHostsError
                ?? (model.accountPairFailedHostId == nil ? model.accountError : nil) {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                        Button("Retry") {
                            Task { await model.accountRefreshHosts() }
                        }
                        .buttonStyle(.tactile(.glass))
                        .controlSize(.small)
                    }
                }
            }
            if !split.notPairedHere.isEmpty {
                Section("On Your Account") {
                    ForEach(split.notPairedHere) { row in
                        AccountHostListRow(model: model, row: row, pair: request)
                            .swipeActions {
                                if !model.accountBusy {
                                    Button("Remove", role: .destructive) { removing = row.pending }
                                        .tint(.red)
                                }
                            }
                            .contextMenu {
                                Button("Remove from Account", image: .trash2, role: .destructive) {
                                    removing = row.pending
                                }
                                .disabled(model.accountBusy)
                            }
                    }
                }
            }
        }
    }

    /// Pairing away from a connected host asks first; anything else pairs.
    private func request(_ row: AccountHostRow) {
        if model.connected, model.currentHostKey != row.storedHostKey {
            asking = row
        } else {
            model.pairFromHosts(row)
        }
    }
}

extension AccountHostRow {
    var pending: PendingAccountHost { PendingAccountHost(hostId: hostId, name: name) }
}

extension View {
    /// What the Hosts rows open: the ask before pairing away from the
    /// current host, and Remove from Account. Refreshes the account's hosts
    /// once when the list appears, so a host that joined since shows up.
    func hostsActions(
        model: AppModel, asking: Binding<AccountHostRow?>, removing: Binding<PendingAccountHost?>
    ) -> some View {
        modifier(HostsActions(model: model, asking: asking, removing: removing))
    }
}

private struct HostsActions: ViewModifier {
    let model: AppModel
    @Binding var asking: AccountHostRow?
    @Binding var removing: PendingAccountHost?

    func body(content: Content) -> some View {
        content
            .task(id: model.accountSession?.username) {
                guard model.accountSession != nil else { return }
                await model.accountRefreshHosts()
            }
            // Leaving the list drops a Pair still waiting for its invite: a
            // late one must not take over the page the reader went to.
            .onDisappear { model.cancelAccountPairingAsk() }
            .alert(
                "Pair with this host?",
                isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })
            ) {
                Button("Cancel", role: .cancel) { asking = nil }
                Button("Pair") {
                    let row = asking
                    asking = nil
                    if let row { model.pairFromHosts(row) }
                }
            } message: {
                Text("This disconnects \(model.currentHostLabel ?? "the current host") but doesn't forget it.")
            }
            .sheet(item: $removing) { host in
                FormSheet {
                    RemoveHostView(
                        model: model, host: host,
                        server: model.accountSession.map { hostOf($0.serverOrigin) } ?? "the server")
                }
            }
    }
}

extension AppModel {
    /// The Hosts list's two halves, from the pairings held now.
    var hostsPartition: HostsPartition {
        AccountHosts.partition(rows: accountRows, storedHostKeys: machines.map(\.hostKey))
    }

    /// Make the Pair still waiting for its invite stale, and clear its
    /// progress. Background registrations carry on; only that host's asks
    /// are dropped.
    func cancelAccountPairingAsk() {
        guard let hostId = accountPairingHostId else { return }
        accountPairingEpochs.invalidate(hostId: hostId)
        accountPairingHostId = nil
        accountBusy = false
    }

    /// Pair from a Hosts row. A pairing takes over the screen; a sheet the
    /// list sits in would cover it, so it closes.
    func pairFromHosts(_ row: AccountHostRow) {
        Task {
            if await pairViaAccount(hostId: row.hostId), modal != nil {
                modal = nil
            }
        }
    }
}

/// A host paired here: its status, Pair again when the account says so,
/// and its own page.
private struct PairedHostRow: View {
    let model: AppModel
    let host: HostRecord
    let issue: AccountHostRow?
    let pair: (AccountHostRow) -> Void

    var body: some View {
        NavigationLink(value: Route.machine(host.hostKey)) {
            HStack(spacing: 10) {
                MachineDot(live: model.isConnected(host.hostKey))
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.machineLabel(host.hostKey))
                        .foregroundStyle(.primary)
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(issue == nil ? Color.secondary : Color.orange)
                        .lineLimit(3)
                    if let issue { FieldError(message: model.accountPairError(for: issue.hostId)) }
                }
                Spacer(minLength: 8)
                if let issue {
                    PairButton(model: model, row: issue, title: "Pair Again") { pair(issue) }
                }
            }
        }
    }

    private var status: String {
        switch issue?.status {
        case .rejected: "This host refused this iPhone."
        case .keyChanged: "The host's identity changed. Pair again only if you reinstalled it."
        default: model.connectionLabel(for: host.hostKey)
        }
    }
}

/// One of the account's hosts this device hasn't paired: online or when
/// last seen, why it can't be paired right now, and Pair where it can.
private struct AccountHostListRow: View {
    let model: AppModel
    let row: AccountHostRow
    let pair: (AccountHostRow) -> Void

    var body: some View {
        HStack(spacing: 10) {
            MachineDot(live: row.online, label: row.online ? "Online" : "Offline")
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                Text(row.pairingReason ?? (row.online ? "Online" : "Offline"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                FieldError(message: model.accountPairError(for: row.hostId))
            }
            Spacer(minLength: 8)
            if row.pairable {
                PairButton(model: model, row: row, title: "Pair") { pair(row) }
            }
        }
    }
}

/// The row's one action, or its progress while that pairing is asked for.
private struct PairButton: View {
    let model: AppModel
    let row: AccountHostRow
    let title: String
    let action: () -> Void

    var body: some View {
        if model.accountPairingHostId == row.hostId {
            ProgressView().controlSize(.small)
        } else {
            Button(title, action: action)
                .buttonStyle(.tactile(.glass))
                .controlSize(.small)
                .disabled(!row.pairable || model.accountBusy)
        }
    }
}

/// Settings → Hosts on a page of its own, for the New Host Joined alert's
/// Review Hosts.
struct HostsPage: View {
    let model: AppModel

    @State private var asking: AccountHostRow?
    @State private var removing: PendingAccountHost?

    var body: some View {
        List {
            HostsSections(model: model, asking: $asking, removing: $removing)
        }
        .navigationTitle("Hosts")
        .hostsActions(model: model, asking: $asking, removing: $removing)
    }
}

/// Green while this machine is connected (or online), grey otherwise.
struct MachineDot: View {
    let live: Bool
    var label: String?

    var body: some View {
        Circle()
            .fill(live ? Color.green : Color.secondary.opacity(0.5))
            .frame(width: 8, height: 8)
            .accessibilityLabel(label ?? (live ? "Connected" : "Not connected"))
    }
}

/// A confirmation form over the page that asked for it, with its own Cancel.
/// The form's own `dismiss` closes the sheet once it is done.
struct FormSheet<Content: View>: View {
    @ViewBuilder let content: () -> Content

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }
}

extension AppModel {
    /// Why Pair failed on this account host's row, if it was the last one.
    func accountPairError(for hostId: String) -> String? {
        accountPairFailedHostId == hostId ? accountError : nil
    }
}
