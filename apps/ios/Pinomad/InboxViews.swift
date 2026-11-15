import PinomadChat
import PinomadCore
import SwiftUI

// The Inbox mode (ADR-0051): the home list's Inbox rows, the intake before
// its first message, a task the worker hasn't taken, and the cards a
// transcript draws for batches and filed tasks. On a phone the list pushes
// the conversation, as the design canvas notes.

/// A project's name, never its path.
func inboxProjectName(_ project: String, organized: Organized?) -> String {
    organized?.projects.first { $0.project.path == project }?.project.name
        ?? (project as NSString).lastPathComponent
}

/// One machine's Inboxes under its header in Inbox mode: each project's row
/// opens its intake, then its tasks in their groups, each opening its
/// conversation (or, still queued, its page).
struct InboxMachineRows: View {
    let model: AppModel
    let hostKey: String
    /// Filters the tasks by title while searching.
    let query: String

    var body: some View {
        let runtime = model.runtimes[hostKey]
        if case .failed(let failure)? = runtime?.phase {
            NavigationLink(value: Route.machineUnavailable(hostKey)) {
                Label { Text(failure.statusTitle).lineLimit(1) } icon: { Image(.cloudOff) }
                    .foregroundStyle(.secondary)
            }
            .listRowBackground(Color.clear)
        } else if let snapshot = runtime?.snapshot {
            if let inboxes = model.inboxes(hostKey) {
                if inboxes.isEmpty {
                    Text("No projects yet. Add one in Coding; each project has its own Inbox.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
                let summaries = Inbox.summaries(snapshot.organized)
                ForEach(inboxes, id: \.project) { inbox in
                    projectRows(inbox, organized: snapshot.organized, summaries: summaries)
                }
            } else {
                Text(snapshot.host == nil ? "Connecting…" : "This host is too old for the Inbox. Run `pinomad upgrade` on it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
        } else {
            GroupRowsSkeleton()
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }

    @ViewBuilder
    private func projectRows(
        _ inbox: ProjectInbox, organized: Organized, summaries: [UInt64: ConversationSummary]
    ) -> some View {
        let sections = Inbox.sections(inbox, summaries: summaries).compactMap { section -> InboxTaskSection? in
            guard !query.isEmpty else { return section }
            let tasks = section.tasks.filter { $0.task.title.localizedCaseInsensitiveContains(query) }
            return tasks.isEmpty ? nil : InboxTaskSection(group: section.group, tasks: tasks)
        }
        let name = inboxProjectName(inbox.project, organized: organized)
        if query.isEmpty || !sections.isEmpty {
            HStack(spacing: 12) {
                Button {
                    model.navPath.append(model.intakeRoute(hostKey, inbox))
                } label: {
                    HStack(spacing: 12) {
                        Image(.inbox)
                            .foregroundStyle(.secondary)
                            .frame(width: 28)
                        Text(name)
                            .font(.body.weight(.semibold))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                    }
                    .contentShape(.rect)
                }
                .accessibilityHint("Opens the intake, where you tell the Inbox what needs doing")
                Button {
                    model.navPath.append(.inboxSettings(hostKey: hostKey, project: inbox.project))
                } label: {
                    Image(.settings)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Inbox settings for \(name)")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.primary)
            .padding(.vertical, 6)
            .listRowBackground(Color.clear)
            .quietSeparator()
            if sections.isEmpty {
                Text("No tasks. Tap \(name) to hand the Inbox something.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 40)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(sections) { section in
                Text(section.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 40)
                    .padding(.top, 4)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .accessibilityAddTraits(.isHeader)
                ForEach(section.tasks) { info in
                    NavigationLink(value: model.taskRoute(hostKey, project: inbox.project, info.task)) {
                        InboxTaskRow(info: info)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            }
        }
    }
}

/// A task in the list: its state light, title and where it stands.
struct InboxTaskRow: View {
    let info: InboxTaskInfo

    var body: some View {
        HStack(spacing: 12) {
            InboxTaskDot(state: info.state)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(info.task.title.isEmpty ? "Task" : info.task.title)
                    .lineLimit(1)
                    .foregroundStyle(info.state == .done || info.state == .skipped ? .secondary : .primary)
                Text(info.text)
                    .font(.caption)
                    .foregroundStyle(info.state == .failed ? Color.red : Color.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A task's state light. Decorative: the row says the state in words.
/// Queued is an empty ring (nothing has happened yet); a closed task is grey.
struct InboxTaskDot: View {
    let state: InboxTaskState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch state {
            case .pending:
                Circle().strokeBorder(Color.secondary, lineWidth: 1.5)
            case .running:
                Circle().fill(Color.green)
                    .phaseAnimator(reduceMotion ? [1.0] : [1.0, 0.35]) { dot, opacity in
                        dot.opacity(opacity)
                    } animation: { _ in .easeInOut(duration: 1.2) }
            case .waiting:
                Circle().fill(Color.orange)
            case .failed:
                Circle().fill(Color.red)
            case .done, .skipped:
                Circle().fill(Color.secondary.opacity(0.5))
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }
}

/// The events that started (or continued) a task: where each came from, its
/// summary, when it reached the Inbox, and — on the last — when the worker
/// handed it over.
struct InboxEventCard: View, Equatable {
    let events: [InboxEvent]
    let startedAt: Double?
    let today: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Image(.inbox)
                        Text(Inbox.sourceLabel(event.source))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(times(event, last: index == events.count - 1))
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text(event.summary)
                        .font(.subheadline)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemFill), in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Inbox events")
    }

    private func times(_ event: InboxEvent, last: Bool) -> String {
        var parts: [String] = []
        if let received = MessageTime(timestamp: event.receivedAt, today: today) {
            parts.append("Received \(received.label)")
        }
        if last, let startedAt, let started = MessageTime(timestamp: startedAt, today: today) {
            parts.append("Started \(started.label)")
        }
        return parts.joined(separator: " · ")
    }
}

/// The tasks an intake's run filed, one card each, under its answer. A card
/// whose task the Inbox still lists opens it.
struct InboxFiledCards: View {
    let cards: [InboxFiledCard]
    let open: (InboxTask) -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach(cards) { card in
                if let task = card.task {
                    Button { open(task) } label: { label(card) }
                        .buttonStyle(.press)
                        .accessibilityHint("Opens the task")
                } else {
                    label(card)
                }
            }
        }
    }

    private func label(_ card: InboxFiledCard) -> some View {
        HStack(spacing: 10) {
            Group {
                if let state = card.state { InboxTaskDot(state: state) } else { Color.clear }
            }
            .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(card.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if card.task != nil {
                Image(.chevronRight)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color(.separator), lineWidth: 0.5) }
        .contentShape(.rect(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

/// A project's intake before its first message. The host opens it with that
/// message, so this sends it, and the page becomes the conversation once the
/// host names it — only while this page is still on top.
struct IntakeDraftView: View {
    let model: AppModel
    let hostKey: String
    let project: String

    @State private var text = ""
    /// One id per message: a retry of the same text can't file it twice.
    @State private var requestId = UUID().uuidString
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var page: Route { .intakeDraft(hostKey: hostKey, project: project) }

    var body: some View {
        let inbox = model.projectInbox(hostKey, project: project)
        let connected = model.isConnected(hostKey)
        ScrollView {
            ContentUnavailableView {
                Label("Tell the Inbox what needs doing", image: .inbox)
            } description: {
                Text("Describe a bug or a job, or ask how the tasks stand. The intake asks what's unclear and files tasks for the worker; it changes no code itself.")
            }
            .padding(.top, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaBar(edge: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 8)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("A bug, a job to do, or a question about progress…", text: $text, axis: .vertical)
                        .lineLimit(1...8)
                        .focused($focused)
                        .padding(.vertical, 10)
                        .padding(.leading, 16)
                        .disabled(sending)
                    Button {
                        send()
                    } label: {
                        Group {
                            if sending { ProgressView() } else { Image(.arrowUp).font(.body.weight(.semibold)) }
                        }
                        .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.circle)
                    .disabled(!canSend(connected: connected))
                    .accessibilityLabel("Send")
                    .padding(.trailing, 6)
                    .padding(.bottom, 6)
                }
                .glassEffect(.regular, in: .rect(cornerRadius: ConversationComposer.cardCornerRadius))
            }
            .padding(.horizontal, 12)
            .padding(.bottom, ConversationComposer.bottomInset)
        }
        .onChange(of: text) { _, _ in
            // Another message gets its own id; the same text keeps it for a retry.
            if !sending { requestId = UUID().uuidString }
        }
        .onChange(of: inbox?.intake, initial: true) { _, intake in
            // Opened from another device meanwhile: show it, and keep what
            // was typed here as its composer draft. While a send is in
            // flight the text is that message, already on its way.
            guard let intake else { return }
            let unsent = sending ? "" : text
            guard model.replaceInboxPage(page, with: .conversation(ConversationRef(hostKey: hostKey, conversationId: intake))),
                  let runtime = model.runtimes[hostKey],
                  let draft = Inbox.carryingDraft(unsent, into: runtime.drafts[intake]) else { return }
            runtime.drafts[intake] = draft
        }
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model, hostKey: hostKey) }
        .navigationTitle(inboxProjectName(project, organized: model.runtimes[hostKey]?.snapshot?.organized))
        .navigationSubtitle("Intake")
        .navigationBarTitleDisplayMode(.inline)
        .task { focused = true }
    }

    private func canSend(connected: Bool) -> Bool {
        connected && !sending && !text.allSatisfy(\.isWhitespace)
    }

    private func send() {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend(connected: model.isConnected(hostKey)) else { return }
        sending = true
        error = nil
        let id = requestId
        Task {
            do {
                let intake = try await model.sendToIntake(hostKey, project: project, text: message, requestId: id)
                sending = false
                text = ""
                requestId = UUID().uuidString
                // Web dureview: the reader may have moved to another page or
                // host meanwhile — only this page, still on top, moves on.
                model.replaceInboxPage(page, with: .conversation(ConversationRef(hostKey: hostKey, conversationId: intake)))
            } catch {
                sending = false
                self.error = model.describe(error)
            }
        }
    }
}

/// A task still in the queue: its events, its place, and Skip. The worker
/// opens its conversation when it takes it, and the page becomes that
/// conversation while it is on top.
struct QueuedTaskView: View {
    let model: AppModel
    let hostKey: String
    let project: String
    let taskId: String

    @State private var skipping = false
    @State private var today = Date.now

    private var page: Route { .inboxTask(hostKey: hostKey, project: project, task: taskId) }

    var body: some View {
        let inbox = model.projectInbox(hostKey, project: project)
        let info = inbox.flatMap { Inbox.describe($0, summaries: model.inboxSummaries(hostKey))[taskId] }
        Group {
            if let info {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        InboxEventCard(events: info.task.events, startedAt: nil, today: today)
                        queueLine(info)
                    }
                    .padding(16)
                }
            } else {
                ContentUnavailableView { Label("This task is gone", image: .inbox) }
            }
        }
        // `initial`: a task the worker already took when the page opened
        // goes straight to its conversation.
        .onChange(of: info?.task.conversationId, initial: true) { _, id in
            guard let id else { return }
            model.replaceInboxPage(page, with: .conversation(ConversationRef(hostKey: hostKey, conversationId: id)))
        }
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model, hostKey: hostKey) }
        .navigationTitle(info.map { $0.task.title.isEmpty ? "Task" : $0.task.title } ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func queueLine(_ info: InboxTaskInfo) -> some View {
        let pending = info.state == .pending
        let origin = "\(Inbox.taskOrigin(info.task)) · \(info.text)"
        let text = pending
            ? origin + ". The worker takes tasks one at a time and opens this one's conversation when it starts."
            : origin
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if pending {
                Button {
                    skip(info.task)
                } label: {
                    if skipping { ProgressView() } else { Text("Skip") }
                }
                .buttonStyle(.tactile(.bordered))
                .controlSize(.small)
                .disabled(skipping || !model.isConnected(hostKey))
            }
        }
    }

    private func skip(_ task: InboxTask) {
        skipping = true
        Task {
            do {
                try await model.skipInboxTask(hostKey, project: project, task: task.id)
            } catch {
                model.runtimes[hostKey]?.showToast(
                    "Couldn't skip \(task.title): \(model.describe(error))", level: .error, key: "inbox-skip")
            }
            skipping = false
        }
    }
}
