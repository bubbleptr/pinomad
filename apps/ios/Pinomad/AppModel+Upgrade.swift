import Foundation
import PinomadChat
import PinomadCore

/// Settings → Upgrade (ADR-0043). Start, cancel and check are request-class:
/// the page shows a refusal inline. Their progress arrives in the host's
/// `upgrade` stream, not in these results, so another device's upgrade shows
/// here too. Every call, the setting included, is bounded: a host that stays
/// connected but never answers ends in an inline timeout, not a silent page.
extension AppModel {
    /// How long a call may go unanswered before the page says so; the host may still act on it.
    static let upgradeCallTimeout: Duration = .seconds(30)

    func startUpgrade(_ when: UpgradeWhen, on host: String) async throws {
        try await upgradeCall(.startUpgrade(when: when), on: host)
    }

    func cancelUpgrade(on host: String) async throws {
        try await upgradeCall(.cancelUpgrade, on: host)
    }

    func checkUpgrade(on host: String) async throws {
        try await upgradeCall(.checkUpgrade, on: host)
    }

    /// The `autoUpgrade` setting. Command-class: a refusal lands as a
    /// notice and the picker stays on the host's value.
    func setAutoUpgrade(_ mode: AutoUpgradeMode, on host: String) async throws {
        try await upgradeCall(.setAutoUpgrade(mode: mode), on: host)
    }

    private func upgradeCall(_ call: FfiCall, on host: String) async throws {
        guard let runtime = runtimes[host], runtime.isConnectedNow, let session = runtime.session else {
            throw SessionError.sessionClosed
        }
        _ = try await answered(
            within: Self.upgradeCallTimeout,
            orThrow: SessionError.operationFailed(
                "The host didn't answer. It may still act on the request; this page updates when it does.")
        ) { try await session.invoke(call) }
    }
}
