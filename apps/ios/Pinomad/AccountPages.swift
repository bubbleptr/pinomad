import PinomadCore
import SwiftUI

/// Settings → Account (ADR-0022), one page in groups: who is signed in
/// where, with Sign out; the email; every sign-in method, one row each;
/// the signed-in devices; and the two account-wide
/// actions set apart under Danger Zone. Every change confirms in a sheet or
/// an alert; nothing expands in place.
struct AccountPage: View {
    let model: AppModel

    private enum Sheet: Identifiable {
        case signOut, delete, email
        case password(hasPassword: Bool)
        case unlink(String), link(String)
        case removeDevice(AccountDevice)

        var id: String {
            switch self {
            case .signOut: "sign-out"
            case .delete: "delete"
            case .email: "email"
            case .password: "password"
            case .unlink(let provider): "unlink:\(provider)"
            case .link(let provider): "link:\(provider)"
            case .removeDevice(let device): "device:\(device.id)"
            }
        }
    }

    @State private var open: Sheet?
    @State private var confirmingSignOutEverywhere = false
    /// What the last sign-in change said ("Password set.", "GitHub linked.").
    @State private var notice: String?

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
                    AccountInitial(name: session.displayName)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.displayName)
                            .font(.headline)
                        Text(server)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button("Sign Out") { open = .signOut }
                        .buttonStyle(.tactile(.glass))
                        .controlSize(.small)
                        .disabled(model.accountBusy)
                }
                ForEach([notice, model.accountNotice, model.accountSignOutWarning].compactMap { $0 }, id: \.self) { line in
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(line == notice ? .secondary : Color.orange)
                }
            }

            Section("Email") {
                HStack {
                    Text(session.email ?? "None yet")
                        .foregroundStyle(session.email == nil ? .secondary : .primary)
                    Spacer(minLength: 8)
                    Button(session.email == nil ? "Add" : "Change") { open = .email }
                        .buttonStyle(.tactile(.glass))
                        .controlSize(.small)
                        .disabled(model.accountBusy)
                }
            }

            methodsSection

            // Hidden on servers that predate the device list.
            if !model.accountDevicesUnsupported {
                devicesSection
            }

            Section {
                DangerRow(
                    title: "Sign Out Everywhere",
                    detail: "Ends every session on every device, including this one.",
                    disabled: model.accountBusy
                ) { confirmingSignOutEverywhere = true }
                DangerRow(
                    title: "Delete Account",
                    detail: "Removes your account from \(server). Devices stay paired with your hosts.",
                    disabled: model.accountBusy
                ) { open = .delete }
            } header: {
                Text("Danger Zone")
                    .foregroundStyle(.red)
            }

            LegalLinksSection()
        }
        .refreshable { await model.refreshAccountPages() }
        .task { await model.refreshAccountPages() }
        .sheet(item: $open) { sheet in
            FormSheet {
                switch sheet {
                case .signOut: SignOutForm(model: model, server: server)
                case .delete: DeleteAccountView(model: model, server: server)
                case .email: ChangeEmailView(model: model) { notice = "Email saved." }
                case .password(let hasPassword):
                    ChangePasswordView(model: model, hasPassword: hasPassword) { notice = $0 }
                case .unlink(let provider):
                    UnlinkProviderView(model: model, provider: provider) { notice = $0 }
                case .link(let provider):
                    LinkProviderView(model: model, provider: provider) { notice = $0 }
                case .removeDevice(let device): RemoveDeviceView(model: model, device: device)
                }
            }
            .presentationDetents(sheet.id == "sign-out" ? [.medium, .large] : [.large])
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

    // MARK: Sign-in methods

    /// The server's providers the account hasn't linked, in row order;
    /// none until the server said which it offers.
    private func linkable(_ identities: AccountIdentities) -> [String] {
        let offered = model.accountServerMethods?.providers ?? []
        let linked = Set(identities.identities.map(\.provider))
        return SignInProviders.ids.filter { offered.contains($0) && !linked.contains($0) }
    }

    /// The password, each linked provider and each one to link, a row
    /// apiece (ADR-0044 §4, #631). A server from before sign-in methods
    /// keeps the password alone.
    private var methodsSection: some View {
        Section("Sign-in Methods") {
            if model.accountIdentitiesUnsupported {
                passwordRow(hasPassword: true)
            } else if let identities = model.accountIdentities {
                passwordRow(hasPassword: identities.hasPassword)
                ForEach(identities.identities, id: \.provider) { identity in
                    linkedRow(identity)
                }
                ForEach(linkable(identities), id: \.self) { provider in
                    MethodRow(name: SignInProviders.name(provider), detail: "Not linked") {
                        SignInProviderMark(provider: provider, size: 20)
                    } action: {
                        Button("Link") { open = .link(provider) }
                            .buttonStyle(.tactile(.glass))
                            .controlSize(.small)
                            .disabled(model.accountBusy)
                            .accessibilityLabel("Link \(SignInProviders.name(provider))")
                    }
                }
            } else if let failed = model.accountIdentitiesError {
                RetryLine(message: "Couldn't load sign-in methods. \(failed)") {
                    await model.accountRefreshIdentities()
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    private func passwordRow(hasPassword: Bool) -> some View {
        MethodRow(name: "Password", detail: hasPassword ? "Set" : "Not set") {
            Image(.keyRound)
        } action: {
            Button(hasPassword ? "Change" : "Set") { open = .password(hasPassword: hasPassword) }
                .buttonStyle(.tactile(.glass))
                .controlSize(.small)
                .disabled(model.accountBusy)
        }
    }

    /// A linked provider; Remove is in its menu and swipe, not a button.
    private func linkedRow(_ identity: AccountIdentity) -> some View {
        let name = SignInProviders.name(identity.provider)
        return MethodRow(name: name, detail: identity.email) {
            SignInProviderMark(provider: identity.provider, size: 20)
        } action: {
            RowMenu(label: "More for \(name)", disabled: model.accountBusy) {
                Button("Remove", image: .trash2, role: .destructive) { open = .unlink(identity.provider) }
            }
        }
        .swipeActions {
            if !model.accountBusy {
                Button("Remove", role: .destructive) { open = .unlink(identity.provider) }
            }
        }
    }

    // MARK: Devices

    /// Every install signed in to the account (#452, ADR-0037), the hosts
    /// each joined through it, and Remove in each row's menu.
    private var devicesSection: some View {
        Section {
            if let devices = model.accountDevices {
                ForEach(devices) { device in
                    deviceRow(device)
                }
            } else if model.accountDevicesError == nil {
                ProgressView().controlSize(.small)
            }
            if let error = model.accountDevicesError {
                RetryLine(message: error) { await model.accountRefreshDevices() }
            }
        } header: {
            Text("Signed-in Devices")
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
            Spacer(minLength: 8)
            if device.current {
                Badge("This device")
            } else if device.kickedAt != nil {
                Badge("Removed")
            } else if device.removable {
                RowMenu(label: "More for \(device.name ?? "Unknown device")", disabled: model.accountBusy) {
                    Button("Remove", image: .trash2, role: .destructive) { open = .removeDevice(device) }
                }
            }
        }
        .swipeActions {
            if device.removable, !model.accountBusy {
                Button("Remove", role: .destructive) { open = .removeDevice(device) }
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

/// The account's initial in a circle, beside its name.
private struct AccountInitial: View {
    let name: String

    var body: some View {
        Text(name.first.map { String($0).uppercased() } ?? "?")
            .font(.headline)
            .foregroundStyle(.tint)
            .frame(width: 40, height: 40)
            .background(Color.accentColor.opacity(0.15), in: .circle)
            .accessibilityHidden(true)
    }
}

/// One sign-in method: its mark in a fixed box so every name lines up, what
/// state it is in, and its one action.
private struct MethodRow<Mark: View, Action: View>: View {
    let name: String
    let detail: String?
    @ViewBuilder let mark: () -> Mark
    @ViewBuilder let action: () -> Action

    var body: some View {
        HStack(spacing: 12) {
            mark()
                .frame(width: 20, height: 20)
                .frame(width: 36, height: 36)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            action()
        }
    }
}

/// A row's ⋯ menu.
private struct RowMenu<Items: View>: View {
    let label: String
    let disabled: Bool
    @ViewBuilder let items: () -> Items

    var body: some View {
        Menu {
            items()
        } label: {
            Image(.ellipsis)
                .frame(width: 32, height: 32)
                .contentShape(.rect)
        }
        .accessibilityLabel(label)
        .disabled(disabled)
    }
}

/// A load that failed, and Retry.
private struct RetryLine: View {
    let message: String
    let retry: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button("Retry") { Task { await retry() } }
                .buttonStyle(.tactile(.glass))
                .controlSize(.small)
        }
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
