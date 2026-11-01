/// After a host join is confirmed on this iPhone (#497): ask for the
/// account's hosts every few seconds until the confirmed host has paired.
/// The host learns of the confirm on its next poll, then joins, restarts
/// its service and comes online, which can take a while; automatic
/// registration only runs on a refresh, and the Account page has no refresh
/// loop of its own. Sleeping is injected so tests run in virtual time.
public enum HostJoinWatch {
    public enum Poll: Equatable, Sendable {
        case waiting
        case paired
        case signedOut
    }

    public enum Outcome: Equatable, Sendable {
        case paired
        case signedOut
        case timedOut
        case cancelled
    }

    public static let interval: Duration = .seconds(5)
    public static let limit: Duration = .seconds(120)

    /// `poll` refreshes and says where the host stands. The first one runs
    /// one interval after the start; the last at `limit`.
    @MainActor
    public static func run(
        interval: Duration = HostJoinWatch.interval,
        limit: Duration = HostJoinWatch.limit,
        sleep: (Duration) async throws -> Void,
        poll: () async -> Poll
    ) async -> Outcome {
        var elapsed: Duration = .zero
        while elapsed < limit {
            do {
                try await sleep(interval)
            } catch {
                return .cancelled
            }
            elapsed += interval
            switch await poll() {
            case .paired: return .paired
            case .signedOut: return .signedOut
            case .waiting: continue
            }
        }
        return .timedOut
    }
}
