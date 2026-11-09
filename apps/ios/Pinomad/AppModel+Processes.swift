import PinomadCore

/// The overview's process list lives on the focused host's session; stop
/// one process through the same serialized event queue as every other call.
/// Watching is bound to the opening runtime by `ProcessWatchSession`.
extension AppModel {
    func stopProcess(root: UInt64, id: String) async throws {
        guard let runtime = focusedRuntime else { throw SessionError.sessionClosed }
        try await runtime.stopProcess(root: root, id: id)
    }
}
