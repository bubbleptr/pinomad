import PinomadCore
import SwiftUI

/// The one account (ADR-0022), opened from the avatar. Signed out, this is
/// the login form; signed in, the hosts the account vouches for, the devices
/// signed in to it (#452), the two ways to sign out and deleting the account
/// (#451). One sheet either way, so signing in lands on the account's hosts
/// instead of closing.
struct AccountView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var pendingAccountPair: AccountHostRow?
    @State private var confirmingSignOutEverywhere = false
    /// Sign out also takes this iPhone off the account's hosts (#494).
    @State private var leavingHosts = false
    @State private var passwordChanged = false
    @State private var removingDevice: AccountDevice?
    #if DEBUG
    /// `PINOMAD_DEMO_ACCOUNT=delete` opens on the Delete Account form.
    @State private var devDeleting = false
    /// `PINOMAD_DEMO_ACCOUNT=add` opens on Add a Host.
    @State private var devAdding = false
    /// `PINOMAD_DEMO_ACCOUNT=bottom`, read up front: the sheet's own task
    /// clears the page it was asked for.
    @State private var devOpensAtBottom: Bool

    init(model: AppModel) {
        self.model = model
        _devOpensAtBottom = State(initialValue: model.devAccountPage == "bottom")
    }
    #endif

    var body: some View {
        NavigationStack {
            if let session = model.accountSession {
                signedIn(session)
            } else {
                AccountLoginView(model: model)
            }
        }
        // Any session change (Sign out everywhere, a dead token, a new
        // sign-in) starts the shared-device choice off again.
        .onChange(of: model.accountSession) { leavingHosts = false }
        .onDisappear {
            // Closing the sheet cancels a pairing ask that is still
            // waiting; a late offer must not replace the session the
            // reader went back to.
            model.invalidateAccountPairing()
        }
    }

    private func signedIn(_ session: AccountSession) -> some View {
        ScrollViewReader { proxy in
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
                    NavigationLink("Add a Host") {
                        AddAccountHostView(model: model)
                    }
                }

                // Hidden on servers that predate the device list.
                if !model.accountDevicesUnsupported {
                    devicesSection
                }

                Section {
                    NavigationLink("Change Password") {
                        ChangePasswordView(model: model) { passwordChanged = true }
                    }
                    .disabled(model.accountBusy)
                } footer: {
                    if passwordChanged {
                        Text("Password changed. Your other devices were signed out.")
                    }
                }

                Section {
                    if let warning = model.accountSignOutWarning {
                        Text(warning)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }

                    // Off by default and reset with the view: a host keeps
                    // every revocation, so each sign-out of your own phone
                    // would leave a dead key in its device list (#494).
                    Toggle(isOn: $leavingHosts) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Remove this iPhone from my hosts")
                            Text(AccountCopy.signOutRevokeExplanation)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(model.accountBusy)

                    Button("Sign out", role: .destructive) {
                        let revoke = leavingHosts
                        // Never carried into the next sign-in on this sheet.
                        leavingHosts = false
                        Task { await model.accountSignOut(everywhere: false, revoke: revoke) }
                    }
                    .disabled(model.accountBusy)

                    Button("Sign out everywhere", role: .destructive) {
                        confirmingSignOutEverywhere = true
                    }
                    .disabled(model.accountBusy)
                } footer: {
                    Text(AccountCopy.signOutExplanation)
                }

                // The server refuses to delete its admin account.
                if model.accountRecord?.admin != true {
                    Section {
                        NavigationLink {
                            DeleteAccountView(model: model, server: hostOf(session.serverOrigin))
                        } label: {
                            Text("Delete Account")
                                .foregroundStyle(model.accountBusy ? Color.secondary : Color.red)
                        }
                        .disabled(model.accountBusy)
                        .id("delete-account")
                    }
                }

                LegalLinksSection()
            }
            #if DEBUG
            .task {
                // `PINOMAD_DEMO_ACCOUNT=bottom` opens scrolled to Delete Account.
                guard devOpensAtBottom else { return }
                try? await Task.sleep(for: .milliseconds(300))
                proxy.scrollTo("delete-account", anchor: .top)
            }
            #endif
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $removingDevice) { device in
            RemoveDeviceView(model: model, device: device)
        }
        .refreshable {
            await model.refreshHostsAndAccount()
            await model.accountRefreshDevices()
        }
        .task {
            #if DEBUG
            let page = model.devAccountPage
            model.devAccountPage = nil
            switch page {
            case "remove": removingDevice = model.accountDevices?.first(where: \.removable)
            case "delete": devDeleting = true
            case "add": devAdding = true
            default: break
            }
            #endif
            // Side by side: a slow host list mustn't hold the devices back.
            async let hosts: Void = model.accountRefreshHosts()
            async let devices: Void = model.accountRefreshDevices()
            _ = await (hosts, devices)
        }
        #if DEBUG
        .navigationDestination(isPresented: $devDeleting) {
            DeleteAccountView(model: model, server: hostOf(session.serverOrigin))
        }
        .navigationDestination(isPresented: $devAdding) {
            AddAccountHostView(model: model)
        }
        #endif
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
        // The root shows it while no sheet is up; here while this one is.
        .alert("New Host Joined", isPresented: Binding(
            get: { model.newHostNotice != nil },
            set: { if !$0 { model.newHostNotice = nil } }
        )) {
            Button("OK") { model.newHostNotice = nil }
        } message: {
            Text((model.newHostNotice ?? "") + "\n\n" + HostLinkCopy.newHostsHint)
        }
    }

    private var devicesSection: some View {
        Section {
            if let devices = model.accountDevices {
                ForEach(devices) { device in
                    deviceRow(device)
                }
            } else if model.accountDevicesError == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading devices…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = model.accountDevicesError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Devices")
        } footer: {
            Text("Every app and browser signed in to your account, and the hosts each joined through it.")
        }
    }

    private func deviceRow(_ device: AccountDevice) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(device.current ? "This iPhone" : device.name ?? "Unknown device")
                Text(signInLine(device))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !device.hosts.isEmpty {
                    Text(device.hosts
                        .map { "\($0.name): \(AccountCopy.deviceHostState($0.state))" }
                        .joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if device.removable {
                Button("Remove") { removingDevice = device }
                    .buttonStyle(.tactile(.glass))
                    .controlSize(.small)
                    .disabled(model.accountBusy)
            } else if device.kickedAt != nil {
                Text("Removed")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .swipeActions {
            if device.removable, !model.accountBusy {
                Button("Remove", role: .destructive) { removingDevice = device }
            }
        }
    }

    private func signInLine(_ device: AccountDevice) -> String {
        let signIn = "Last sign-in " + relative(device.lastSeenAt)
        guard let kickedAt = device.kickedAt else { return signIn }
        return signIn + " · removed " + relative(kickedAt)
    }

    private func relative(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000).formatted(.relative(presentation: .named))
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

/// The official server's privacy policy and terms (#455), at the foot of
/// the account screens. A self-hosted server's operator answers for its
/// own; the pages say so.
struct LegalLinksSection: View {
    var body: some View {
        Section {
        } footer: {
            HStack(spacing: 6) {
                Link("Privacy Policy", destination: URL(string: "https://pinomad.si/privacy/")!)
                Text("·")
                Link("Terms of Service", destination: URL(string: "https://pinomad.si/terms/")!)
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
        }
    }
}
