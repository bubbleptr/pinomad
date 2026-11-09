import PinomadCore

/// The overview's process list lives on the focused host's session: watch
/// its family root while the sheet is up, and stop one process through the
/// same serialized event queue as every other call.
extension AppModel {
    func watchProcesses(_ root: UInt64) {
        focusedRuntime?.watchProcesses(root)
    }

    func unwatchProcesses() {
        focusedRuntime?.unwatchProcesses()
    }

    func stopProcess(root: UInt64, id: String) async throws {
        guard let runtime = focusedRuntime else { throw SessionError.sessionClosed }
        try await runtime.stopProcess(root: root, id: id)
    }
}
