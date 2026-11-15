import PinomadChat
import PinomadCore
import SwiftUI

/// The add form: a schedule, a plugin's source or a webhook, and for the
/// last two how far their tasks are trusted (restricted by default). Held
/// open while the host adds: its answer closes the form (or shows a
/// webhook's secret), and must not land on a form opened after it.
struct AddInboxSourceView: View {
    let model: AppModel
    let hostKey: String
    let project: String
    let plugins: [PluginInfo]
    /// The host takes plugin and webhook sources (it has a sandbox for Inbox runs).
    let externalSources: Bool
    /// Closes the form, with a new webhook's access to show once.
    let close: (InboxWebhookAccess?) -> Void

    @State private var form: InboxSourceForm
    @State private var tried = false
    @State private var saving = false
    @State private var error: String?

    init(
        model: AppModel, hostKey: String, project: String, plugins: [PluginInfo], externalSources: Bool,
        close: @escaping (InboxWebhookAccess?) -> Void
    ) {
        self.model = model
        self.hostKey = hostKey
        self.project = project
        self.plugins = plugins
        self.externalSources = externalSources
        self.close = close
        var form = InboxSourceForm(zone: TimeZone.current.identifier, plugins: plugins)
        #if DEBUG
        // Screenshots: `PINOMAD_INBOX_SHEET=add:plugin` opens on that kind.
        if externalSources, let kind = ProcessInfo.processInfo.environment["PINOMAD_INBOX_SHEET"]?
            .split(separator: ":").dropFirst().first.flatMap({ InboxSourceForm.Kind(rawValue: String($0)) }) {
            form.kind = kind
        }
        #endif
        _form = State(initialValue: form)
    }

    private var withSources: [PluginInfo] { InboxSourceForm.withSources(plugins) }
    private var nothingToPick: Bool { form.kind == .plugin && withSources.isEmpty }

    var body: some View {
        let problems = tried ? form.problems : InboxSourceForm.Problems()
        NavigationStack {
            Form {
                Section {
                    if externalSources {
                        Picker("Kind", selection: $form.kind) {
                            Text("Schedule").tag(InboxSourceForm.Kind.schedule)
                            Text("Plugin").tag(InboxSourceForm.Kind.plugin)
                            Text("Webhook").tag(InboxSourceForm.Kind.webhook)
                        }
                        .pickerStyle(.segmented)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    }
                } footer: {
                    if !externalSources {
                        Text("Plugin and webhook sources need a sandbox for Inbox runs, which this host doesn't have, so it takes schedules only.")
                    }
                }
                Section {
                    TextField(namePlaceholder, text: $form.name)
                } header: {
                    Text("Name")
                } footer: {
                    problem(problems.name)
                }
                switch form.kind {
                case .schedule: scheduleSections(problems)
                case .plugin: pluginSections(problems)
                case .webhook:
                    Section {
                        Text("Takes signed POSTs from your LAN and tailnet. Its URL and secret show once, after you add it.")
                            .foregroundStyle(.secondary)
                    }
                }
                if form.kind != .schedule {
                    Section {
                        Picker("Tasks from this source can use", selection: $form.trusted) {
                            trustOption("Restricted tools",
                                        "Someone else wrote it. Reading is fine; installing packages or reaching the network waits for you.")
                                .tag(false)
                            trustOption("All tools", "Like a task you submit yourself.")
                                .tag(true)
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: {
                        Text("Tasks from this source can use")
                    }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .disabled(saving)
            .onChange(of: form.kind) { _, _ in error = nil }
            .navigationTitle("Add an Event Source")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { close(nil) }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Add") { submit() }
                            .disabled(!model.isConnected(hostKey) || nothingToPick)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
    }

    private var namePlaceholder: String {
        switch form.kind {
        case .schedule: "Dependency check"
        case .plugin: "Bugs on acme/web"
        case .webhook: "NAS backups"
        }
    }

    @ViewBuilder
    private func problem(_ text: String?) -> some View {
        if let text { Text(text).foregroundStyle(.red) }
    }

    private func trustOption(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func scheduleSections(_ problems: InboxSourceForm.Problems) -> some View {
        Section {
            Picker("Repeat", selection: $form.repeatKind) {
                Text("Every day").tag(InboxSourceForm.Repeat.daily)
                Text("Weekdays").tag(InboxSourceForm.Repeat.weekdays)
                Text("Every week").tag(InboxSourceForm.Repeat.weekly)
                Text("Cron").tag(InboxSourceForm.Repeat.cron)
            }
            if form.repeatKind == .weekly {
                Picker("Day", selection: $form.day) {
                    ForEach(InboxScheduleText.days.indices, id: \.self) { index in
                        Text(InboxScheduleText.days[index]).tag(index)
                    }
                }
            }
            if form.repeatKind == .cron {
                TextField("0 9 * * 1-5", text: $form.cron)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                DatePicker("Time", selection: HourMinute.binding($form.time), displayedComponents: .hourAndMinute)
            }
            LabeledContent("Time zone") {
                TextField("Europe/Berlin", text: $form.zone)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } header: {
            Text("When")
        } footer: {
            problem(problems.time ?? problems.cron ?? problems.zone)
        }
        Section {
            TextField("Look for outdated dependencies and open a task for each one worth upgrading.",
                      text: $form.note, axis: .vertical)
                .lineLimit(3...)
        } header: {
            Text("Task")
        } footer: {
            if let note = problems.note {
                Text(note).foregroundStyle(.red)
            } else {
                Text("Each time it fires, this opens a task named after the source.")
            }
        }
    }

    @ViewBuilder
    private func pluginSections(_ problems: InboxSourceForm.Problems) -> some View {
        if withSources.isEmpty {
            Section {
                Text("No loaded plugin offers event sources. Install one, such as the GitHub example, and it shows up here.")
                    .foregroundStyle(.secondary)
            }
        } else {
            let picked = form.picked(among: plugins)
            Section {
                Picker("Plugin", selection: Binding(
                    get: { form.plugin },
                    set: { form.pick(plugin: $0, among: plugins) }
                )) {
                    ForEach(withSources, id: \.name) { plugin in
                        Text(plugin.name).tag(plugin.name)
                    }
                }
                Picker("Event", selection: $form.event) {
                    ForEach(plugins.first { $0.name == form.plugin }?.sources ?? [], id: \.name) { source in
                        Text(source.description.isEmpty ? source.name : source.description).tag(source.name)
                    }
                }
            } footer: {
                if picked?.followedOnly == true {
                    Text("Only reaches a task that already follows the thread, such as a pull request the agent opened.")
                }
            }
            if let filter = picked?.filter {
                Section {
                    TextField("Filter", text: $form.filter)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Filter")
                } footer: {
                    if let problem = problems.filter {
                        Text(problem).foregroundStyle(.red)
                    } else {
                        Text(filter)
                    }
                }
            }
        }
    }

    private func submit() {
        tried = true
        guard !saving, let spec = form.spec(plugins: plugins) else { return }
        saving = true
        error = nil
        let name = form.name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                let webhook = try await model.addInboxSource(
                    hostKey, project: project, name: name, trusted: form.effectiveTrusted, spec: spec)
                close(webhook)
            } catch {
                saving = false
                self.error = model.describe(error)
            }
        }
    }
}

/// A 24-hour `HH:mm` edited through a DatePicker. Both directions read the
/// same calendar and zone, so the device's zone never shifts the value.
enum HourMinute {
    static func binding(_ text: Binding<String>) -> Binding<Date> {
        Binding(
            get: {
                let minutes = QuietHoursText.minutes(text.wrappedValue) ?? 9 * 60
                return date(minutes)
            },
            set: { text.wrappedValue = QuietHoursText.clock(minutes($0)) }
        )
    }

    static func date(_ minutes: UInt32) -> Date {
        Calendar.current.date(bySettingHour: Int(minutes / 60), minute: Int(minutes % 60), second: 0, of: .now) ?? .now
    }

    static func minutes(_ date: Date) -> UInt32 {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return UInt32((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
    }
}

/// A webhook's URL, source id and secret, shown this once. The secret
/// lives only in this sheet's state: closing it forgets the secret.
struct WebhookAccessView: View {
    let model: AppModel
    let hostKey: String
    let title: String
    let close: () -> Void

    @State private var access: InboxWebhookAccess
    @State private var resetting = false
    @State private var error: String?
    @State private var copied: String?

    init(model: AppModel, hostKey: String, title: String, initial: InboxWebhookAccess, close: @escaping () -> Void) {
        self.model = model
        self.hostKey = hostKey
        self.title = title
        self.close = close
        _access = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Copy the secret now: it isn't shown again. Reset it if it's lost.")
                        .foregroundStyle(.secondary)
                }
                value("URL", access.url,
                      footer: "From another machine on your tailnet, put the host's MagicDNS name in place of the address.")
                value("Source", access.source, footer: "Sent as the X-Pinomad-Source header.")
                value("Secret", access.secret,
                      footer: "Signs each request: X-Pinomad-Signature is the HMAC-SHA256 of “<timestamp>.<body>”.")
                Section {
                    Button {
                        reset()
                    } label: {
                        if resetting { ProgressView() } else { Text("Reset Secret") }
                    }
                    .disabled(resetting || !model.isConnected(hostKey))
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: close).disabled(resetting)
                }
            }
            .sensoryFeedback(.success, trigger: copied)
        }
        .interactiveDismissDisabled()
    }

    private func value(_ label: String, _ text: String, footer: String) -> some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                Text(text)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    UIPasteboard.general.string = text
                    copied = label
                } label: {
                    Image(copied == label ? .check : .copy)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy \(label)")
            }
        } header: {
            Text(label)
        } footer: {
            Text(footer)
        }
    }

    private func reset() {
        resetting = true
        error = nil
        Task {
            do {
                access = try await model.resetInboxWebhookSecret(hostKey, source: access.source)
                copied = nil
            } catch {
                self.error = model.describe(error)
            }
            resetting = false
        }
    }
}
