import Foundation
import PinomadChat
import PinomadCore

/// The token clear did not come back in time — the host may have kept the
/// registration, so forgetting proceeds with the revocation warning.
private struct PushUnregisterTimeout: Error {}

/// A pairing link waiting for the reader's go-ahead. `url` is where it
/// would connect, or nil when the link isn't a usable pairing link.
struct PendingPairing: Equatable {
    let link: String
    let target: PairingTarget?
}

/// Pairing entry points and the host list: every link — pasted, scanned,
/// opened as `pinomad://pair#…` — goes through the same confirm page, and
/// switching or forgetting a host goes through the keychain record first,
/// so the launch host is always the one on screen.
extension AppModel {
    /// Label per stored host — its address, told apart by key when two
    /// hosts share one (e.g. behind the same relay).
    var hostLabels: [String: String] {
        Dictionary(
            PinomadCore.hostLabels(hosts: hosts.hosts.map(\.ffi)).map { ($0.hostKey, $0.label) },
            uniquingKeysWith: { first, _ in first })
    }

    /// What the screens call the host the session is for.
    var currentHostLabel: String? {
        if let host = sessionHost { return hostLabels[host.hostKey] ?? hostOf(host.url) }
        return pairingTarget.map { hostOf($0.url) }
    }

    /// Show the confirm page for `text` (an invalid link gets the page's
    /// invalid state). Returns whether it was a usable link, for fields
    /// that would rather say so inline.
    @discardableResult
    func offerPairing(_ text: String) -> Bool {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let target = PinomadCore.pairingTarget(link: link)
        present(.confirm(PendingPairing(link: link, target: target)))
        return target != nil
    }

    /// Whether `text` is a usable pairing link — for inline checks before
    /// leaving a field.
    func isPairingLink(_ text: String) -> Bool {
        PinomadCore.pairingTarget(link: text.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
    }

    /// Back out of a pairing whose handshake never completed — the
    /// keychain is unchanged, so its launch host is the one from before.
    func cancelPairing() {
        connectActive()
    }

    /// The host to offer going back to from a failure page: the one the
    /// device was on before a pairing whose handshake went through (making
    /// the new host the launch one) but whose session then failed.
    var previousHostKey: String? {
        guard let key = hostBeforePairing, key != currentHostKey,
              hosts.hosts.contains(where: { $0.hostKey == key })
        else { return nil }
        return key
    }

    /// Try the same thing again — the link for a pairing, else the host.
    /// Also the manual reconnect for a closed session, which never
    /// retries on its own.
    func retryConnection() {
        if let link = pairingLink {
            pair(link: link, account: pairingAccount)
        } else if let host = sessionHost {
            // After a pairing's handshake this is the identity it stored —
            // the link's code is spent, so pairing again would be refused.
            connect(host)
        } else {
            connectActive()
        }
    }

    /// Make `hostKey` the launch host and connect to it.
    func switchHost(_ hostKey: String) {
        guard hostKey != currentHostKey || phase != .connected else { return }
        var saveError: String?
        do {
            try store.update { $0 = $0.activating(hostKey) }
        } catch {
            saveError = describe(error)
        }
        reloadHosts()
        guard let host = hosts.hosts.first(where: { $0.hostKey == hostKey }) else { return }
        connect(host)
        // After `connect`: starting a session clears the last one's error.
        // Connecting anyway is right — only the next launch would open the
        // old host — but the reader should know.
        if let saveError {
            lastError = "没能记住所选宿主（\(saveError)）：重启 App 后会打开之前的宿主。"
        }
    }

    /// Drop `hostKey`'s pairing, clearing this device's push registration
    /// first when it can (ADR-0025 §9). A host that can't be reached — or
    /// refuses the clear — is still forgotten; the reader is sent to the
    /// host's Devices page instead.
    func forget(_ hostKey: String) {
        // The switch is not proof either way: it may have been turned off
        // while offline after a successful registration. The flag is set
        // before a register and cleared only by a successful clear, so it
        // is the one judgement here.
        let plan = pushForgetPlan(
            mayHaveRegistration: push.mayHaveRegistration(for: hostKey),
            canClear: hostKey == currentHostKey && phase == .connected && connected
                && hostSupports("setPushToken"))
        // Stop token callbacks from queuing a fresh register behind the
        // clearing request while this host is being removed.
        forgettingHosts.insert(hostKey)
        Task { [weak self] in
            guard let self else { return }
            var warning: String?
            switch plan {
            case .forget:
                break
            case .forgetWithWarning:
                warning = "已忘记这台宿主。它可能还留着这台设备的推送登记；到宿主的「设备」页面吊销这台设备后，推送就会停止。"
            case .clearThenForget:
                do {
                    guard let session = self.session else { throw SessionError.sessionClosed }
                    try await self.clearPushRegistration(on: session)
                    self.push.setMayHaveRegistration(false, for: hostKey)
                } catch is PushUnregisterTimeout {
                    warning = "已忘记这台宿主，但注销推送等宿主超时。到宿主的「设备」页面吊销这台设备后，推送就会停止。"
                } catch {
                    warning = "已忘记这台宿主，但没能注销推送登记（\(self.describe(error))）。到宿主的「设备」页面吊销这台设备后，推送就会停止。"
                }
            }
            self.forgetNow(hostKey, warning: warning)
        }
    }

    /// The clear is bounded: a black-holed connection must not keep the
    /// pairing on the device forever.
    private func clearPushRegistration(on session: PinomadSession) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                _ = try await session.invoke(.setPushToken(token: nil))
            }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                throw PushUnregisterTimeout()
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    private func forgetNow(_ hostKey: String, warning: String?) {
        forgettingHosts.remove(hostKey)
        do {
            try store.update { $0 = $0.forgetting(hostKey) }
        } catch {
            lastError = "没能忘记这台宿主：\(describe(error))"
            return
        }
        push.forget(hostKey)
        accountHostForgotten(hostKey)
        if hostKey == currentHostKey {
            connectActive()
        } else {
            reloadHosts()
        }
        if let warning { pushForgetWarning = warning }
        advancePushTarget()
    }

    /// The host's one-time pairing offer for another device. Request-class:
    /// the host rejects with a message the sheet shows.
    func createPairingOffer() async -> Result<PairingCodeOffer, PairingCodeFailure> {
        guard let session else {
            return .failure(PairingCodeFailure(message: "还没连上宿主。"))
        }
        do {
            switch try await session.invoke(.createPairing) {
            case .pairing(let url, let expiresAt):
                return .success(PairingCodeOffer(url: url, expiresAt: expiresAt))
            default:
                return .failure(PairingCodeFailure(message: "宿主没有返回配对信息。"))
            }
        } catch {
            return .failure(PairingCodeFailure(message: describe(error)))
        }
    }
}

/// A one-time pairing URL and when it dies (epoch ms).
struct PairingCodeOffer: Equatable {
    let url: String
    let expiresAt: Double
}

struct PairingCodeFailure: Error, Equatable {
    let message: String
}

/// `host[:port]` of a URL, for "pair with …".
func hostOf(_ url: String) -> String {
    guard let components = URLComponents(string: url), let host = components.host else { return url }
    return components.port.map { "\(host):\($0)" } ?? host
}
