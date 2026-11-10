import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

/// Settings, grouped by what the reader wants to change: the account,
/// this iPhone's own General page, and every host this device can use —
/// each paired one opening its own settings. Pushed from the list; needs
/// no connection.
struct SettingsView: View {
    let model: AppModel

    @State private var asking: AccountHostRow?
    @State private var removing: PendingAccountHost?
    @State private var query = ""

    var body: some View {
        List {
            if shows(accountKeywords) { accountSection }

            if shows(GeneralSettingsView.keywords) {
                Section {
                    NavigationLink(value: Route.general) {
                        Label("General", image: .settings)
                    }
                }
            }

            if shows(hostKeywords) {
                HostsSections(model: model, asking: $asking, removing: $removing)
            }

            if !query.isEmpty, !shows(accountKeywords + GeneralSettingsView.keywords + hostKeywords) {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationTitle("Settings")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search settings")
        .hostsActions(model: model, asking: $asking, removing: $removing)
    }

    /// Whether a section answers the search: its name or one of its words.
    private func shows(_ keywords: [String]) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || keywords.contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    private var accountKeywords: [String] {
        ["Account", "Sign in", "Sign out", "Email", "Password", "Sign-in methods", "Signed-in devices",
         "Delete account", "GitHub", "Google", "Apple"]
            + [model.accountSession?.displayName].compactMap { $0 }
    }

    /// The hosts, and what each one's page holds: a search for a host
    /// setting finds the list it is a tap under.
    private var hostKeywords: [String] {
        ["Hosts", "Add Host", "Pair", "Unpair", "Connection", "Routes"]
            + MachineSettingsView.keywords
            + model.machines.map { model.machineLabel($0.hostKey) } + model.accountRows.map(\.name)
    }

    /// Signed in, the account's page; signed out, only the way in, which
    /// stays a sheet of its own.
    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let session = model.accountSession, !model.accountNeedsEmail {
                NavigationLink(value: Route.account) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.displayName)
                            Text(hostOf(session.serverOrigin))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(.userRound)
                    }
                }
            } else {
                Button {
                    model.present(.account)
                } label: {
                    Label(model.accountSession == nil ? "Sign In" : "Finish Signing In", image: .userRound)
                }
                .tint(.primary)
            }
        } header: {
            Text("Account")
        } footer: {
            if model.accountSession == nil {
                Text("Sign in to pair the hosts on your account.")
            }
        }
    }
}

/// Settings → General: this iPhone's own settings — its look, whether
/// hosts may notify it, and the app's version. Works with every host down.
struct GeneralSettingsView: View {
    let model: AppModel

    @Environment(\.openURL) private var openURL
    @AppStorage(Appearance.storageKey) private var appearance = Appearance.system

    /// What Settings' search finds this page by.
    static let keywords = [
        "General", "Appearance", "Theme", "Light", "Dark", "Dark mode", "System",
        "Notifications", "Push", "Alerts", "About", "App version",
    ]

    var body: some View {
        List {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            pushSection
            Section("About") {
                LabeledContent("App version", value: appVersion)
            }
        }
        .navigationTitle("General")
    }

    /// The app-level switch. Every connected host registers or clears; a host
    /// that is still connecting catches up when it becomes ready.
    @ViewBuilder
    private var pushSection: some View {
        Section {
            pushControls
        } header: {
            Text("Notifications")
        } footer: {
            Text("Notifications carry only the conversation title and the event (\"Waiting for your answer\", \"Finished\", \"Failed\"); titles pass through the server and Apple.")
        }
    }

    @ViewBuilder
    private var pushControls: some View {
        Toggle("Push notifications", isOn: Binding(
            get: { model.pushEnabled },
            set: { model.setPushEnabled($0) }
        ))

        let outdated = model.machines.filter {
            model.isConnected($0.hostKey) && !model.hostSupports(.apnsPush, on: $0.hostKey)
        }
        if !outdated.isEmpty {
            Text("Update \(ListFormatter.localizedString(byJoining: outdated.map { model.machineLabel($0.hostKey) })) to 5.9 or later to get notifications.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if model.pushEnabled {
            if model.push.isDenied {
                Text("Notification permission is denied, so notifications won't arrive.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                Button("Turn on notifications in Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                }
                .font(.footnote)
            }

            if model.accountSession == nil {
                Text("Sign in to the account your hosts joined. The server only delivers notifications to devices signed in to the same account.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let error = model.serverPushError {
                Text("Couldn't register this device with the server: \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            if let error = model.pushError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if let error = model.push.registrationError {
                Text("APNs registration failed: \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
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
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            SettingsView(model: model)
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: Route.self) { route in
                    RouteDestination(model: model, route: route)
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .environment(\.popToProviders, PopToProvidersAction(stack: "settings") { path.popToProviders() })
        // This stack isn't navPath; the focus must follow it all the same.
        .onChange(of: path) { _, path in model.followVisiblePage(path.last) }
        .onDisappear { model.followVisiblePage(model.navPath.last) }
    }
}

