import PinomadCore
import SwiftUI

/// Settings → Account (ADR-0022): who is signed in where, with Sign out;
/// a line for each of the account's pages saying what it holds; and the two
/// account-wide actions set apart under Danger Zone. Every action confirms
/// in a sheet or an alert; nothing expands in place.
struct AccountPage: View {
    let model: AppModel

    @State private var signingOut = false
    @State private var confirmingSignOutEverywhere = false
    @State private var deleting = false

    var body: some View {
        Group {
            if let session = model.accountSession {
                signedIn(session)
            } else {
                AccountSignedOutView(model: model)
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func signedIn(_ session: AccountSession) -> some View {
        let server = hostOf(session.serverOrigin)
        return List {
            Section {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.displayName)
                            .font(.headline)
                        Text(server)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button("Sign Out…") { signingOut = true }
                        .buttonStyle(.tactile(.glass))
                        .controlSize(.small)
                        .disabled(model.accountBusy)
                }
                ForEach([model.accountNotice, model.accountSignOutWarning].compactMap { $0 }, id: \.self) { notice in
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }

            Section {
                NavigationLink(value: Route.accountSecurity) {
                    LabeledContent("Sign-in Methods", value: methodsSummary ?? "")
                }
                if !model.accountDevicesUnsupported {
                    NavigationLink(value: Route.accountDevices) {
                        LabeledContent("Signed-in Devices", value: devicesSummary ?? "")
                    }
                }
                NavigationLink(value: Route.hosts) {
                    LabeledContent("Hosts on This Account", value: hostsSummary)
                }
            }

            Section("Danger Zone") {
                DangerRow(
                    title: "Sign Out Everywhere…",
                    detail: "Ends every session on every device, including this one.",
                    disabled: model.accountBusy
                ) { confirmingSignOutEverywhere = true }
                DangerRow(
                    title: "Delete Account…",
                    detail: "Removes your account from \(server). Devices stay paired with your hosts.",
                    disabled: model.accountBusy
                ) { deleting = true }
            }

            LegalLinksSection()
        }
        .refreshable { await model.refreshAccountPages() }
        .task { await model.refreshAccountPages() }
        .sheet(isPresented: $signingOut) {
            FormSheet { SignOutForm(model: model, server: server) }
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $deleting) {
            FormSheet { DeleteAccountView(model: model, server: server) }
        }
        .alert("Sign out everywhere?", isPresented: $confirmingSignOutEverywhere) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out Everywhere", role: .destructive) {
                Task { await model.accountSignOut(everywhere: true) }
            }
        } message: {
            Text("Your account is signed out on every device, and each one needs to sign in again before it gets notifications. Paired hosts stay paired.")
        }
    }

    /// "Password, GitHub": the account's ways in.
    private var methodsSummary: String? {
        // A server from before sign-in methods: only the password, as it always was.
        if model.accountIdentitiesUnsupported { return "Password" }
        guard let identities = model.accountIdentities else { return nil }
        let ways = (identities.hasPassword ? ["Password"] : [])
            + identities.identities.map { SignInProviders.name($0.provider) }
        return ways.isEmpty ? "None" : ways.joined(separator: ", ")
    }

    private var devicesSummary: String? {
        guard let devices = model.accountDevices else { return nil }
        let active = devices.filter { $0.kickedAt == nil }.count
        return active == 1 ? "1 device" : "\(active) devices"
    }

    private var hostsSummary: String {
        let total = model.accountRows.count
        guard total > 0 else { return model.accountHostsLoaded ? "None yet" : "" }
        let unpaired = model.hostsPartition.notPairedHere.count
        let hosts = total == 1 ? "1 host" : "\(total) hosts"
        return unpaired == 0 ? hosts : "\(hosts), \(unpaired) not paired here"
    }
}

/// One account-wide action: the button that opens its confirmation, and a
/// line saying what it does.
private struct DangerRow: View {
    let title: String
    let detail: String
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button(title, action: action)
                .buttonStyle(.tactile(.glass))
                .controlSize(.small)
                .disabled(disabled)
        }
        .padding(.vertical, 4)
    }
}

/// Sign out, with the shared-iPhone choice off by default: a host keeps
/// every revocation, so each sign-out of your own phone would leave a dead
/// key in its device list (#494). The choice lives and dies with the sheet.
private struct SignOutForm: View {
    let model: AppModel
    let server: String

    @Environment(\.dismiss) private var dismiss
    @State private var leavingHosts = false

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $leavingHosts) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Remove this iPhone from my hosts")
                        Text(AccountCopy.signOutRevokeExplanation)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text(AccountCopy.signOutExplanation)
            }

            FormActionButton(title: "Sign Out", busy: false, destructive: true) {
                let revoke = leavingHosts
                dismiss()
                Task { await model.accountSignOut(everywhere: false, revoke: revoke) }
            }
        }
        .navigationTitle("Sign Out of \(server)?")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The account pages once the session is gone (signed out here or
/// elsewhere, or the account deleted): what happened, and the way back in.
private struct AccountSignedOutView: View {
    let model: AppModel

    var body: some View {
        List {
            ForEach([model.accountNotice, model.accountSignOutWarning].compactMap { $0 }, id: \.self) { notice in
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            Button("Sign In") { model.present(.account) }
        }
    }
}

/// Settings → Sign-in and Security: the email, the password and each linked
/// provider, one action a row. Unlinked providers sit in one Link Another
/// menu however many the server offers.
struct SignInSecurityPage: View {
    let model: AppModel

    private enum Sheet: Identifiable {
        case email, password(hasPassword: Bool), unlink(String), link(String)

        var id: String {
            switch self {
            case .email: "email"
            case .password: "password"
            case .unlink(let provider): "unlink:\(provider)"
            case .link(let provider): "link:\(provider)"
            }
        }
    }

    @State private var open: Sheet?
    /// What the last change said ("Password set.", "Email saved.").
    @State private var notice: String?

    var body: some View {
        Group {
            if let session = model.accountSession {
                List {
                    emailSection(session)
                    methodsSection
                }
                .refreshable {
                    await model.accountRefreshIdentities()
                    await model.accountRefreshServerMethods()
                }
                .task {
                    async let identities: Void = model.accountRefreshIdentities()
                    async let profile: Void = model.accountRefreshProfile()
                    async let methods: Void = model.accountRefreshServerMethods()
                    _ = await (identities, profile, methods)
                }
            } else {
                AccountSignedOutView(model: model)
            }
        }
        .navigationTitle("Sign-in and Security")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $open) { form in
            FormSheet {
                switch form {
                case .email:
                    ChangeEmailView(model: model) { notice = "Email saved." }
                case .password(let hasPassword):
                    ChangePasswordView(model: model, hasPassword: hasPassword) { notice = $0 }
                case .unlink(let provider):
                    UnlinkProviderView(model: model, provider: provider) { notice = $0 }
                case .link(let provider):
                    LinkProviderView(model: model, provider: provider) { notice = $0 }
                }
            }
        }
    }

    private func emailSection(_ session: AccountSession) -> some View {
        Section("Email") {
            HStack {
                Text(session.email ?? "None yet")
                    .foregroundStyle(session.email == nil ? .secondary : .primary)
                Spacer(minLength: 8)
                Button(session.email == nil ? "Add…" : "Change…") { open = .email }
                    .buttonStyle(.tactile(.glass))
                    .controlSize(.small)
                    .disabled(model.accountBusy)
            }
        }
    }

    /// The server's providers the account hasn't linked, in menu order;
    /// none until the server said which it offers.
    private func linkable(_ identities: AccountIdentities) -> [String] {
        let offered = model.accountServerMethods?.providers ?? []
        let linked = Set(identities.identities.map(\.provider))
        return SignInProviders.ids.filter { offered.contains($0) && !linked.contains($0) }
    }

    /// The password, each linked provider and the others to link (ADR-0044
    /// §4, #631). A server from before sign-in methods keeps Change Password.
    private var methodsSection: some View {
        Section {
            if model.accountIdentitiesUnsupported {
                passwordRow(hasPassword: true)
            } else if let identities = model.accountIdentities {
                passwordRow(hasPassword: identities.hasPassword)
                ForEach(identities.identities, id: \.provider) { identity in
                    identityRow(identity)
                }
                let others = linkable(identities)
                if !others.isEmpty {
                    HStack {
                        Text("Sign in without a password.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Menu("Link Another…") {
                            ForEach(others, id: \.self) { provider in
                                Button(SignInProviders.name(provider)) { open = .link(provider) }
                            }
                        }
                        .menuStyle(.button)
                        .buttonStyle(.glass)
                        .tint(.primary)
                        .controlSize(.small)
                        .fixedSize()
                        .disabled(model.accountBusy)
                    }
                }
            } else if let failed = model.accountIdentitiesError {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn't load sign-in methods. \(failed)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Retry") {
                        Task { await model.accountRefreshIdentities() }
                    }
                    .buttonStyle(.tactile(.glass))
                    .controlSize(.small)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        } header: {
            Text("Sign-in Methods")
        } footer: {
            if let notice { Text(notice) }
        }
    }

    private func passwordRow(hasPassword: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Password")
                Text(hasPassword ? "Set" : "Not set")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button(hasPassword ? "Change…" : "Set…") { open = .password(hasPassword: hasPassword) }
                .buttonStyle(.tactile(.glass))
                .controlSize(.small)
                .disabled(model.accountBusy)
        }
    }

    /// A linked provider; Remove is in its menu and swipe, not a button.
    private func identityRow(_ identity: AccountIdentity) -> some View {
        HStack(spacing: 12) {
            SignInProviderMark(provider: identity.provider, size: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(SignInProviders.name(identity.provider))
                if let email = identity.email {
                    Text(email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Menu {
                Button("Remove…", image: .trash2, role: .destructive) { open = .unlink(identity.provider) }
            } label: {
                Image(.ellipsis)
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            }
            .accessibilityLabel("More for \(SignInProviders.name(identity.provider))")
            .disabled(model.accountBusy)
        }
        .swipeActions {
            if !model.accountBusy {
                Button("Remove", role: .destructive) { open = .unlink(identity.provider) }
            }
        }
    }
}

/// Settings → Signed-in Devices (#452, ADR-0037): every install signed in
/// to the account, the hosts each joined through it, and Remove in each
/// row's menu — which signs it out and asks those hosts to revoke it.
struct AccountDevicesPage: View {
    let model: AppModel

    @State private var removing: AccountDevice?

    var body: some View {
        Group {
            if model.accountSession == nil {
                AccountSignedOutView(model: model)
            } else if model.accountDevicesUnsupported {
                ContentUnavailableView {
                    Label("No Device List", image: .monitor)
                } description: {
                    Text("This server doesn't list the account's devices.")
                }
            } else {
                list
            }
        }
        .navigationTitle("Signed-in Devices")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $removing) { device in
            FormSheet { RemoveDeviceView(model: model, device: device) }
        }
    }

    private var list: some View {
        List {
            Section {
                if let devices = model.accountDevices {
                    ForEach(devices) { device in
                        row(device)
                    }
                } else if model.accountDevicesError == nil {
                    ProgressView().controlSize(.small)
                }
                if let error = model.accountDevicesError {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                        Button("Retry") {
                            Task { await model.accountRefreshDevices() }
                        }
                        .buttonStyle(.tactile(.glass))
                        .controlSize(.small)
                    }
                }
            } footer: {
                Text("Every app and browser signed in to your account, and the hosts each joined through it.")
            }
        }
        .refreshable { await model.accountRefreshDevices() }
        .task {
            async let devices: Void = model.accountRefreshDevices()
            async let hosts: Void = model.accountRefreshHosts()
            _ = await (devices, hosts)
        }
    }

    private func row(_ device: AccountDevice) -> some View {
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
            Spacer(minLength: 8)
            if device.current {
                Badge("This device")
            } else if device.kickedAt != nil {
                Badge("Removed")
            } else if device.removable {
                Menu {
                    Button("Remove…", image: .trash2, role: .destructive) { removing = device }
                } label: {
                    Image(.ellipsis)
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .accessibilityLabel("More for \(device.name ?? "Unknown device")")
                .disabled(model.accountBusy)
            }
        }
        .swipeActions {
            if device.removable, !model.accountBusy {
                Button("Remove", role: .destructive) { removing = device }
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
}

/// "This device", "Removed": the one mark a row may carry.
private struct Badge: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.quaternary, in: .capsule)
    }
}

extension AppModel {
    /// Everything the Account page summarises, side by side: a slow host
    /// list mustn't hold the devices back.
    func refreshAccountPages() async {
        async let hosts: Void = accountRefreshHosts()
        async let devices: Void = accountRefreshDevices()
        async let identities: Void = accountRefreshIdentities()
        async let profile: Void = accountRefreshProfile()
        async let methods: Void = accountRefreshServerMethods()
        _ = await (hosts, devices, identities, profile, methods)
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
