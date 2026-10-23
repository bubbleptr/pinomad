import Foundation
import PinomadChat
import PinomadCore

/// The `$` skill listing for the current host session (issue #143). Lists
/// are cached per scope in `PinomadChat`; the app only runs the calls and
/// feeds answers back, and every entry point stays closed when the host is
/// offline, before 5.13, or has not answered yet.
extension AppModel {
    /// The displayed conversation's scope. Chat conversations list their own
    /// persisted cwd, so they use `conversation` too.
    func conversationSkillScope(_ id: UInt64) -> SkillScope? {
        guard connected, hostSupports("listSkills") else { return nil }
        return .conversation(conversationId: id)
    }

    /// A draft's scope: its project checkout, or the user-only Chat listing.
    func draftSkillScope() -> SkillScope? {
        guard connected, hostSupports("listSkills") else { return nil }
        switch draftHome {
        case .chat:
            return .chat
        case .project(let path):
            return .project(path: path, checkout: draftCheckout)
        }
    }

    /// The last good listing, or nil while the list is unknown. Offline and
    /// pre-5.13 hosts always answer nil, so nothing highlights and no menu
    /// opens even if an old answer is still cached.
    func skills(for scope: SkillScope?) -> [SkillEntry]? {
        guard let scope, connected, hostSupports("listSkills") else { return nil }
        return skillCache.snapshot(scope)
    }

    /// Ask for a scope's listing; the cache merges in-flight asks and skips
    /// a fresh answer. `force` is the reconnect path. Failures are not
    /// cached, so the next focus/keystroke retries.
    func requestSkills(for scope: SkillScope?, force: Bool = false) {
        guard let scope, connected, hostSupports("listSkills"), let session else { return }
        guard let request = skillCache.request(
            scope, now: Date.timeIntervalSinceReferenceDate, force: force)
        else { return }
        let generation = sessionGeneration
        Task { [weak self] in
            do {
                guard case .skills(let skills) = try await session.invoke(.listSkills(scope: scope)) else {
                    throw SessionError.operationFailed("The host's reply wasn't a skill list")
                }
                guard let self, self.sessionGeneration == generation, self.session === session else { return }
                self.skillCache.receive(
                    request, items: skills, now: Date.timeIntervalSinceReferenceDate)
            } catch {
                guard let self, self.sessionGeneration == generation, self.session === session else { return }
                self.skillCache.fail(request)
            }
        }
    }
}
