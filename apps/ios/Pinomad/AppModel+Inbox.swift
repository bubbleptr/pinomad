import Foundation
import PinomadChat
import PinomadCore

/// The home page's two lists (ADR-0051 §1).
enum HomeMode: String, CaseIterable {
    case coding
    case inbox

    static let defaultsKey = "homeMode"

    var title: String {
        switch self {
        case .coding: "Coding"
        case .inbox: "Inbox"
        }
    }
}

/// The Inbox's calls (ADR-0051), each on the host it names: the Inbox pages
/// carry their host, which needn't be the focused one by the time a reply
/// comes back. Request-class: each throws the host's reason.
extension AppModel {
    /// A machine's Inboxes, or nil when its host predates them (5.38).
    func inboxes(_ hostKey: String) -> [ProjectInbox]? {
        guard !isRejected(hostKey) else { return nil }
        return runtimes[hostKey]?.snapshot?.inbox
    }

    func projectInbox(_ hostKey: String, project: String) -> ProjectInbox? {
        inboxes(hostKey)?.first { $0.project == project }
    }

    /// Every summary on the machine by id, for the task states.
    func inboxSummaries(_ hostKey: String) -> [UInt64: ConversationSummary] {
        runtimes[hostKey]?.snapshot.map { Inbox.summaries($0.organized) } ?? [:]
    }

    private func inboxSession(_ hostKey: String) throws -> PinomadSession {
        guard let session = runtimes[hostKey]?.session else { throw SessionError.sessionClosed }
        return session
    }

    /// The intake's first message, which opens it; resolves its id. The
    /// same `requestId` on a retry lets the host drop a duplicate.
    func sendToIntake(_ hostKey: String, project: String, text: String, requestId: String) async throws -> UInt64 {
        let result = try await inboxSession(hostKey).invoke(
            .sendToIntake(project: project, text: text, requestId: requestId))
        guard case .intakeSent(let id) = result else {
            throw SessionError.operationFailed("The host's reply wasn't the intake")
        }
        return id
    }

    func setInboxRules(_ hostKey: String, project: String, rules: String) async throws {
        _ = try await inboxSession(hostKey).invoke(.setInboxRules(project: project, rules: rules))
    }

    func cancelFollowUp(_ hostKey: String, id: String) async throws {
        _ = try await inboxSession(hostKey).invoke(.cancelFollowUp(timerId: id))
    }

    func skipInboxTask(_ hostKey: String, project: String, task: String) async throws {
        _ = try await inboxSession(hostKey).invoke(.skipInboxTask(project: project, taskId: task))
    }

    /// Adds an enabled source; a webhook's URL and secret come back this once.
    func addInboxSource(
        _ hostKey: String, project: String, name: String, trusted: Bool, spec: InboxSourceSpec
    ) async throws -> InboxWebhookAccess? {
        let result = try await inboxSession(hostKey).invoke(
            .addInboxSource(project: project, name: name, trusted: trusted, spec: spec))
        guard case .inboxSourceAdded(_, let webhook) = result else {
            throw SessionError.operationFailed("The host's reply wasn't the new source")
        }
        return webhook
    }

    func setInboxSourceEnabled(_ hostKey: String, source: String, enabled: Bool) async throws {
        _ = try await inboxSession(hostKey).invoke(.setInboxSourceEnabled(sourceId: source, enabled: enabled))
    }

    func removeInboxSource(_ hostKey: String, source: String) async throws {
        _ = try await inboxSession(hostKey).invoke(.removeInboxSource(sourceId: source))
    }

    func resetInboxWebhookSecret(_ hostKey: String, source: String) async throws -> InboxWebhookAccess {
        guard case .inboxWebhook(let access) = try await inboxSession(hostKey).invoke(
            .resetInboxWebhookSecret(sourceId: source))
        else { throw SessionError.operationFailed("The host's reply wasn't the new secret") }
        return access
    }

    /// The host-wide window when `notify` pushes wait (ADR-0052 §4); nil for none.
    func setInboxQuietHours(_ hostKey: String, _ hours: QuietHours?) {
        guard let session = runtimes[hostKey]?.session else { return }
        Task { _ = try? await session.invoke(.setInboxQuietHours(hours: hours)) }
    }

    /// The model a project's new intake conversation starts on; nil follows
    /// the default model.
    func setInboxIntakeModel(_ hostKey: String, _ model: ModelRef?) {
        guard let session = runtimes[hostKey]?.session else { return }
        Task { _ = try? await session.invoke(.setInboxIntakeModel(model: model)) }
    }

    /// The model new Inbox tasks and the memory tidy-up start on; nil follows
    /// the default model.
    func setInboxWorkerModel(_ hostKey: String, _ model: ModelRef?) {
        guard let session = runtimes[hostKey]?.session else { return }
        Task { _ = try? await session.invoke(.setInboxWorkerModel(model: model)) }
    }

    /// Where a project's row leads: its intake once it exists, else the draft
    /// whose send opens it.
    func intakeRoute(_ hostKey: String, _ inbox: ProjectInbox) -> Route {
        if let intake = inbox.intake {
            return .conversation(ConversationRef(hostKey: hostKey, conversationId: intake))
        }
        return .intakeDraft(hostKey: hostKey, project: inbox.project)
    }

    /// Where a task's row leads: its conversation once the worker took it.
    func taskRoute(_ hostKey: String, project: String, _ task: InboxTask) -> Route {
        if let id = task.conversationId {
            return .conversation(ConversationRef(hostKey: hostKey, conversationId: id))
        }
        return .inboxTask(hostKey: hostKey, project: project, task: task.id)
    }

    /// Swap a draft or queued-task page for the conversation it became —
    /// only while that page is still on top: a reply that lands after the
    /// reader moved on (another page, another host) takes them nowhere.
    /// Whether `page` was still on top and so was replaced.
    @discardableResult
    func replaceInboxPage(_ page: Route, with next: Route) -> Bool {
        guard let path = Inbox.replacingTop(navPath, ifTop: page, with: next) else { return false }
        navPath = path
        return true
    }
}
