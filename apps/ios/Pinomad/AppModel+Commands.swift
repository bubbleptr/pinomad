import Foundation
import PinomadChat
import PinomadCore

/// Host-declared `/` commands (issue #254, ADR-0027). Listings are cached per
/// host runtime; the app runs the calls. Everything stays closed offline and
/// on hosts before 5.17, where the `+` menu keeps its plain "Compact
/// Conversation" instead.
extension AppModel {
    /// The conversation's last good listing, or nil while it is unknown —
    /// offline and old hosts always answer nil, so no text is a command.
    func commands(for id: UInt64) -> [CommandEntry]? {
        guard let runtime = focusedRuntime, runtime.isConnectedNow,
              hostSupportsCall(hostMinor: runtime.hostMinor, method: "listCommands")
        else { return nil }
        return runtime.commandCache.snapshot(id)
    }

    /// Ask for a conversation's listing; the cache merges in-flight asks
    /// and skips a fresh answer. `force` is the reconnect path.
    func requestCommands(for id: UInt64, force: Bool = false) {
        guard let runtime = focusedRuntime, runtime.isConnectedNow,
              hostSupportsCall(hostMinor: runtime.hostMinor, method: "listCommands"),
              let session = runtime.session
        else { return }
        guard let request = runtime.commandCache.request(
            id, now: Date.timeIntervalSinceReferenceDate, force: force)
        else { return }
        let generation = runtime.generation
        Task {
            do {
                guard case .commands(let commands) = try await session.invoke(
                    .listCommands(conversationId: id))
                else {
                    throw SessionError.operationFailed("The host's reply wasn't a command list")
                }
                guard runtime.generation == generation else { return }
                runtime.commandCache.receive(
                    request, items: commands, now: Date.timeIntervalSinceReferenceDate)
            } catch {
                guard runtime.generation == generation else { return }
                runtime.commandCache.fail(request)
            }
        }
    }

    /// Run a command parsed from the draft. It goes out at once — never as
    /// steer or follow-up — and leaves no user message; a refusal comes
    /// back as a notice. The draft clears now and returns if the session
    /// was gone.
    func runDraftCommand(conversation id: UInt64, name: String, args: String?) {
        guard let runtime = focusedRuntime, let session = runtime.session else { return }
        let text = runtime.drafts[id] ?? ""
        runtime.drafts[id] = ""
        Task {
            do {
                _ = try await session.invoke(.runCommand(name: name, args: args, target: id))
            } catch {
                if (runtime.drafts[id] ?? "").isEmpty { runtime.drafts[id] = text }
                runtime.lastError = "Couldn't run /\(name): \(error.localizedDescription)"
            }
        }
    }
}
