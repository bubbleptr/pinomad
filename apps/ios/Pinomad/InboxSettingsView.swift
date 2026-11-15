import PinomadChat
import PinomadCore
import SwiftUI

// One project Inbox's settings (ADR-0051 §11): the rules every task reads,
// the event sources, and the follow-ups not yet fired. The Web keeps these
// on its Tasks surface; on a phone they are a page off the project's row.

/// What the settings page shows over itself: the add form, a webhook secret
/// being reset, or a secret shown this once.
enum InboxSourceSheet {
    case add
    case resetting(InboxSource)
    case access(title: String, access: InboxWebhookAccess)
    case rules
}

private struct PresentedSheet: Identifiable {
    let id: Int
    let sheet: InboxSourceSheet
}

struct InboxSettingsView: View {
    let model: AppModel
    let hostKey: String
    let project: String

    /// Every reply checks its token, so it lands only on its own sheet.
    @State private var sheet = LatestSheet<InboxSourceSheet>()
    @State private var flips = InboxSourceFlips()
    /// Sources and follow-ups with a removal or cancel in flight.
    @State private var busy: Set<String> = []
    @State private var confirmRemove: InboxSource?
    @State private var confirmReset: InboxSource?

    var body: some View {
        let snapshot = model.runtimes[hostKey]?.snapshot
        let inbox = model.projectInbox(hostKey, project: project)
        let connected = model.isConnected(hostKey)
        Group {
            if let snapshot, let inbox {
                List {
                    rulesSection(inbox, connected: connected)
                    sourcesSection(inbox, plugins: snapshot.plugins, connected: connected)
                    followUpsSection(inbox, connected: connected)
                }
                .onChange(of: snapshot.version) { _, version in
                    flips.catchUp(inbox.sources, version: version)
                }
            } else {
                ContentUnavailableView {
                    Label("This project has no Inbox", image: .inbox)
                } description: {
                    Text("It may have been removed from the host.")
                }
            }
        }
        .navigationTitle(inboxProjectName(project, organized: snapshot?.organized))
        .hostTitle(model, hostKey: hostKey, title: "\(inboxProjectName(project, organized: snapshot?.organized)) Inbox", page: true)
        .sheet(item: Binding(
            get: { sheet.value.map { PresentedSheet(id: sheet.token, sheet: $0) } },
            set: { if $0 == nil { sheet.dismiss() } }
        )) { presented in
            sheetContent(presented, inbox: inbox, plugins: snapshot?.plugins ?? [],
                         externalSources: snapshot?.inboxExternalSources ?? false)
        }
        #if DEBUG
        // Screenshots: open the add form without a tap.
        .task {
            let request = ProcessInfo.processInfo.environment["PINOMAD_INBOX_SHEET"] ?? ""
            if request.hasPrefix("add") { sheet.present(.add) }
            // `reset` resets the first webhook's secret, which shows it.
            guard request == "reset" else { return }
            for _ in 0..<50 {
                if let webhook = model.projectInbox(hostKey, project: project)?.sources
                    .first(where: { if case .webhook = $0.spec { true } else { false } }) {
                    reset(webhook)
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        #endif
        .alert("Remove \(confirmRemove?.name ?? "")?", isPresented: Binding(
            get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }
        ), presenting: confirmRemove) { source in
            Button("Remove", role: .destructive) { remove(source) }
        } message: { _ in
            Text("Tasks it already opened stay.")
        }
        .alert("Reset the secret of \(confirmReset?.name ?? "")?", isPresented: Binding(
            get: { confirmReset != nil }, set: { if !$0 { confirmReset = nil } }
        ), presenting: confirmReset) { source in
            Button("Reset Secret", role: .destructive) { reset(source) }
        } message: { _ in
            Text("The old secret stops working at once; senders need the new one.")
        }
    }

    // MARK: Rules

    private func rulesSection(_ inbox: ProjectInbox, connected: Bool) -> some View {
        Section {
            if inbox.rules.isEmpty {
                Text("No rules yet.").foregroundStyle(.secondary)
            } else {
                Text(inbox.rules)
                    .textSelection(.enabled)
            }
            Button("Edit Rules") { sheet.present(.rules) }
                .disabled(!connected)
        } header: {
            Text("Rules")
        } footer: {
            Text("Every task reads these when it starts, along with the project's AGENTS.md.")
        }
    }

    // MARK: Sources

    private func sourcesSection(_ inbox: ProjectInbox, plugins: [PluginInfo], connected: Bool) -> some View {
        Section {
            if inbox.sources.isEmpty {
                Text("None yet. A schedule, a plugin or a webhook can open tasks here.")
                    .foregroundStyle(.secondary)
            }
            ForEach(inbox.sources, id: \.id) { source in
                sourceRow(source, plugins: plugins, connected: connected)
            }
            Button {
                sheet.present(.add)
            } label: {
                Label("Add Source", image: .plus)
            }
            .disabled(!connected)
        } header: {
            Text("Event Sources")
        }
    }

    private func sourceRow(_ source: InboxSource, plugins: [PluginInfo], connected: Bool) -> some View {
        let shown = flips.shown(source)
        let working = busy.contains(source.id)
        return HStack(alignment: .top, spacing: 12) {
            Image(sourceIcon(source.spec))
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(source.name)
                Text(sourceDescription(source, plugins: plugins))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let problem = source.problem {
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer(minLength: 8)
            Toggle(source.name, isOn: Binding(
                get: { shown.isOn },
                set: { toggle(source, to: $0) }
            ))
            .labelsHidden()
            .disabled(!connected || shown.busy || working)
            Menu {
                if case .webhook = source.spec {
                    Button("Reset Secret", image: .rotateCw) { confirmReset = source }
                }
                Button("Remove", image: .trash2, role: .destructive) { confirmRemove = source }
            } label: {
                Image(.ellipsis)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .disabled(!connected || working)
            .accessibilityLabel("More for \(source.name)")
        }
        .buttonStyle(.borderless)
        .opacity(working ? 0.5 : 1)
    }

    private func sourceIcon(_ spec: InboxSourceSpec) -> ImageResource {
        switch spec {
        case .schedule: .clock
        case .plugin: .box
        case .webhook: .globe
        }
    }

    private func sourceDescription(_ source: InboxSource, plugins: [PluginInfo]) -> String {
        let trust = source.trusted ? "All tools" : "Restricted tools"
        switch source.spec {
        case .schedule(let schedule, _):
            let when = InboxScheduleText.describe(schedule)
            guard let next = source.next, let time = MessageTime(timestamp: next, today: .now) else { return when }
            return "\(when) · next \(time.label)"
        case .plugin(let plugin, let name, let filter):
            let declared = plugins.first { $0.name == plugin }?.sources.first { $0.name == name }
            return ([declared?.description ?? name, plugin] + (filter.isEmpty ? [] : [filter]) + [trust])
                .joined(separator: " · ")
        case .webhook:
            return "Webhook · \(trust)"
        }
    }

    private func toggle(_ source: InboxSource, to enabled: Bool) {
        flips.begin(source.id, from: source.enabled)
        Task {
            do {
                try await model.setInboxSourceEnabled(hostKey, source: source.id, enabled: enabled)
                // The next snapshot is the truth, whoever flipped it last.
                flips.answered(source.id, at: model.runtimes[hostKey]?.snapshot?.version ?? 0)
            } catch {
                flips.failed(source.id)
                showError("Couldn't turn “\(source.name)” \(enabled ? "on" : "off"): \(model.describe(error))")
            }
        }
    }

    private func remove(_ source: InboxSource) {
        busy.insert(source.id)
        Task {
            do {
                try await model.removeInboxSource(hostKey, source: source.id)
            } catch {
                showError("Couldn't remove “\(source.name)”: \(model.describe(error))")
            }
            busy.remove(source.id)
        }
    }

    /// The new secret shows in a sheet opened now, in its waiting state and
    /// held open until the host answers; the token keeps a late answer off
    /// any other sheet.
    private func reset(_ source: InboxSource) {
        let token = sheet.present(.resetting(source))
        busy.insert(source.id)
        Task {
            do {
                let access = try await model.resetInboxWebhookSecret(hostKey, source: source.id)
                sheet.complete(token, with: .access(title: "New secret for \(source.name)", access: access))
            } catch {
                if sheet.complete(token, with: nil) {
                    showError("Couldn't reset the secret of “\(source.name)”: \(model.describe(error))")
                }
            }
            busy.remove(source.id)
        }
    }

    // MARK: Follow-ups

    private func followUpsSection(_ inbox: ProjectInbox, connected: Bool) -> some View {
        Section {
            if inbox.followUps.isEmpty {
                Text("None scheduled.").foregroundStyle(.secondary)
            }
            ForEach(inbox.followUps, id: \.id) { followUp in
                HStack(spacing: 12) {
                    Image(followUp.every == nil ? .bell : .clock)
                        .foregroundStyle(.secondary)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(followUp.note)
                        Text(followUpDescription(followUp, inbox: inbox))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    // The daily memory tidy-up is the Inbox's own; it can't be cancelled.
                    if followUp.kind != "tidy" {
                        Button {
                            cancel(followUp)
                        } label: {
                            Image(.x)
                                .frame(width: 28, height: 28)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.borderless)
                        .disabled(!connected || busy.contains(followUp.id))
                        .accessibilityLabel("Cancel follow-up: \(followUp.note)")
                    }
                }
            }
        } header: {
            Text("Follow-ups")
        }
    }

    private func followUpDescription(_ followUp: InboxFollowUp, inbox: ProjectInbox) -> String {
        let due = MessageTime(timestamp: followUp.due, today: .now)?.label ?? ""
        if let every = followUp.every { return "\(InboxScheduleText.period(every)) · next \(due)" }
        guard let id = followUp.task, let task = inbox.tasks.first(where: { $0.id == id }) else { return due }
        return "\(due) · set by “\(task.title)”"
    }

    private func cancel(_ followUp: InboxFollowUp) {
        busy.insert(followUp.id)
        Task {
            do {
                try await model.cancelFollowUp(hostKey, id: followUp.id)
            } catch {
                busy.remove(followUp.id)
                showError("Couldn't cancel “\(followUp.note)”: \(model.describe(error))")
            }
        }
    }

    private func showError(_ message: String) {
        model.runtimes[hostKey]?.showToast(message, level: .error, key: "inbox-settings")
    }

    // MARK: Sheets

    @ViewBuilder
    private func sheetContent(
        _ presented: PresentedSheet, inbox: ProjectInbox?, plugins: [PluginInfo], externalSources: Bool
    ) -> some View {
        let token = presented.id
        switch presented.sheet {
        case .add:
            AddInboxSourceView(
                model: model, hostKey: hostKey, project: project, plugins: plugins,
                externalSources: externalSources,
                close: { webhook in
                    sheet.complete(token, with: webhook.map { .access(title: "Webhook added", access: $0) })
                })
        case .resetting:
            // Held until the host answers: once it rotates the secret, the
            // new one must be shown, or senders break with nothing to copy.
            ProgressView("Resetting the secret…")
                .presentationDetents([.medium])
                .interactiveDismissDisabled()
        case .access(let title, let access):
            WebhookAccessView(model: model, hostKey: hostKey, title: title, initial: access) {
                sheet.complete(token, with: nil)
            }
        case .rules:
            InboxRulesEditor(model: model, hostKey: hostKey, project: project, rules: inbox?.rules ?? "") {
                sheet.complete(token, with: nil)
            }
        }
    }
}

/// How a schedule and a follow-up's period read.
enum InboxScheduleText {
    static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    static func describe(_ schedule: InboxSchedule) -> String {
        let (when, zone): (String, String) = switch schedule {
        case .daily(let time, let zone): ("Every day \(time)", zone)
        case .weekdays(let time, let zone): ("Weekdays \(time)", zone)
        case .weekly(let day, let time, let zone):
            ("Every \(days.indices.contains(Int(day)) ? days[Int(day)] : "week") \(time)", zone)
        case .cron(let expression, let zone): ("Cron \(expression)", zone)
        }
        // The zone only when it isn't this device's: most schedules are made where they're read.
        return zone == TimeZone.current.identifier ? when : "\(when) \(zone)"
    }

    static func period(_ ms: Double) -> String {
        let minutes = Int((ms / 60_000).rounded())
        if minutes % 1440 == 0 { return minutes == 1440 ? "Every day" : "Every \(minutes / 1440) days" }
        if minutes % 60 == 0 { return minutes == 60 ? "Every hour" : "Every \(minutes / 60) hours" }
        return "Every \(minutes) minutes"
    }
}

/// The rules, edited whole and saved whole. Held open while saving: the
/// host's answer closes it, and a refusal stays here.
private struct InboxRulesEditor: View {
    let model: AppModel
    let hostKey: String
    let project: String
    let close: () -> Void

    @State private var draft: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    /// `INBOX_RULES_MAX_BYTES` in `packages/protocol/src/inbox.ts`.
    private static let maxBytes = 16 * 1024

    init(model: AppModel, hostKey: String, project: String, rules: String, close: @escaping () -> Void) {
        self.model = model
        self.hostKey = hostKey
        self.project = project
        self.close = close
        _draft = State(initialValue: rules)
    }

    var body: some View {
        let tooLong = draft.utf8.count > Self.maxBytes
        NavigationStack {
            Form {
                Section {
                    TextField("Write a failing test first. Ask before database migrations.", text: $draft, axis: .vertical)
                        .lineLimit(6...)
                        .focused($focused)
                        .disabled(saving)
                } footer: {
                    if tooLong {
                        Text("At most \(Self.maxBytes / 1024) KB").foregroundStyle(.red)
                    } else if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("Every task reads these when it starts, along with the project's AGENTS.md.")
                    }
                }
            }
            .navigationTitle("Rules")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: close).disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .disabled(tooLong || !model.isConnected(hostKey))
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .task { focused = true }
    }

    private func save() {
        saving = true
        error = nil
        Task {
            do {
                try await model.setInboxRules(hostKey, project: project,
                                              rules: draft.trimmingCharacters(in: .whitespacesAndNewlines))
                close()
            } catch {
                saving = false
                self.error = model.describe(error)
            }
        }
    }
}
