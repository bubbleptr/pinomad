import Foundation
import PinomadChat
import PinomadCore

/// Host-declared `/` commands (issue #254, ADR-0027). Listings are cached
/// per conversation in `PinomadChat`; the app runs the calls. Everything
/// stays closed offline and on hosts before 5.15, where the `+` menu keeps
/// its plain "Compact Conversation" instead.
extension AppModel {
    /// The conversation's last good listing, or nil while it is unknown —
    /// offline and old hosts always answer nil, so no text is a command.
    func commands(for id: UInt64) -> [CommandEntry]? {
        guard connected, hostSupports("listCommands") else { return nil }
        return commandCache.snapshot(id)
    }

    /// Ask for a conversation's listing; the cache merges in-flight asks
    /// and skips a fresh answer. `force` is the reconnect path.
    func requestCommands(for id: UInt64, force: Bool = false) {
        guard connected, hostSupports("listCommands"), let session else { return }
        guard let request = commandCache.request(
            id, now: Date.timeIntervalSinceReferenceDate, force: force)
        else { return }
        let generation = sessionGeneration
        Task { [weak self] in
            do {
                guard case .commands(let commands) = try await session.invoke(
                    .listCommands(conversationId: id))
                else {
                    throw SessionError.operationFailed("The host's reply wasn't a command list")
                }
                guard let self, self.sessionGeneration == generation, self.session === session else { return }
                self.commandCache.receive(
                    request, items: commands, now: Date.timeIntervalSinceReferenceDate)
            } catch {
                guard let self, self.sessionGeneration == generation, self.session === session else { return }
                self.commandCache.fail(request)
            }
        }
    }

    /// Run a command parsed from the draft. It goes out at once — never as
    /// steer or follow-up — and leaves no user message; a refusal comes
    /// back as a notice. The draft clears now and returns if the session
    /// was gone.
    func runCommand(conversation id: UInt64, name: String, args: String?) {
        guard let session else { return }
        let text = drafts[id] ?? ""
        drafts[id] = ""
        Task { [weak self] in
            do {
                _ = try await session.invoke(.runCommand(name: name, args: args, target: id))
            } catch {
                guard let self else { return }
                if (self.drafts[id] ?? "").isEmpty { self.drafts[id] = text }
                self.lastError = "Couldn't run /\(name): \(error.localizedDescription)"
            }
        }
    }
}
