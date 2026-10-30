import Foundation
import PinomadChat
import PinomadCore

/// The `$` skill listing for a host session (issue #143). Lists are cached per
/// host runtime, so a listing that lands after focus moved stays on its own
/// host. Every entry point stays closed when that host is offline, before
/// 5.13, or has not answered yet.
extension AppModel {
    /// The displayed conversation's scope. Chat conversations list their own
    /// persisted cwd, so they use `conversation` too.
    func conversationSkillScope(_ id: UInt64) -> SkillScope? {
        guard let runtime = focusedRuntime, runtime.isConnectedNow,
              hostSupportsCall(hostMinor: runtime.hostMinor, method: "listSkills")
        else { return nil }
        return .conversation(conversationId: id)
    }

    /// A draft's scope: its project checkout, or the user-only Chat listing.
    func draftSkillScope() -> SkillScope? {
        guard let runtime = focusedRuntime, runtime.isConnectedNow,
              hostSupportsCall(hostMinor: runtime.hostMinor, method: "listSkills")
        else { return nil }
        switch runtime.draftHome {
        case .chat:
            return .chat
        case .project(let path):
            return .project(path: path, checkout: runtime.draftCheckout)
        }
    }

    /// The last good listing, or nil while the list is unknown. Offline and
    /// pre-5.13 hosts always answer nil, so nothing highlights and no menu
    /// opens even if an old answer is still cached.
    func skills(for scope: SkillScope?) -> [SkillEntry]? {
        guard let scope, let runtime = focusedRuntime, runtime.isConnectedNow,
              hostSupportsCall(hostMinor: runtime.hostMinor, method: "listSkills")
        else { return nil }
        return runtime.skillCache.snapshot(scope)
    }

    /// Ask for a scope's listing; the cache merges in-flight asks and skips
    /// a fresh answer. `force` is the reconnect path. Failures are not
    /// cached, so the next focus/keystroke retries.
    func requestSkills(for scope: SkillScope?, force: Bool = false) {
        guard let scope, let runtime = focusedRuntime, runtime.isConnectedNow,
              hostSupportsCall(hostMinor: runtime.hostMinor, method: "listSkills"),
              let session = runtime.session
        else { return }
        guard let request = runtime.skillCache.request(
            scope, now: Date.timeIntervalSinceReferenceDate, force: force)
        else { return }
        let generation = runtime.generation
        Task {
            do {
                guard case .skills(let skills) = try await session.invoke(.listSkills(scope: scope)) else {
                    throw SessionError.operationFailed("The host's reply wasn't a skill list")
                }
                guard runtime.generation == generation else { return }
                runtime.skillCache.receive(
                    request, items: skills, now: Date.timeIntervalSinceReferenceDate)
            } catch {
                guard runtime.generation == generation else { return }
                runtime.skillCache.fail(request)
            }
        }
    }
}
