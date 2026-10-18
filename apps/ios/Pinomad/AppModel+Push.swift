import Foundation
import PinomadCore

/// The push switch and tapped notifications. The decisions themselves live
/// in `PinomadCore.Push`; this is the thin session/UI assembly.
extension AppModel {
    func pushEnabled(for hostKey: String) -> Bool {
        push.isEnabled(for: hostKey)
    }

    /// A known 5.8-or-older host cannot take the APNs object form. While
    /// disconnected the version is unknown, so the local switch still works
    /// and the next connection decides what to send.
    func pushAvailable(for hostKey: String) -> Bool {
        guard hostKey == currentHostKey, snapshot != nil else { return true }
        return hostSupports(.apnsPush)
    }

    /// The reader flipped a switch: keep the preference per host, ask for
    /// permission the first time it is turned on, and register/clear now if
    /// this host is connected.
    func setPushEnabled(_ enabled: Bool, for hostKey: String) {
        push.setEnabled(enabled, for: hostKey)
        pushError = nil
        if enabled {
            Task { [weak self] in
                guard let self else { return }
                if self.push.authorization == .notDetermined {
                    await self.push.requestAuthorization()
                } else {
                    await self.push.refreshAuthorization()
                }
                self.syncPushToken()
            }
        } else {
            syncPushToken()
        }
    }

    /// A tapped notification replaces any earlier pending one — the latest
    /// tap is the conversation the reader wants.
    func receivePushTarget(_ target: PushTarget) {
        pendingPush = target
        advancePushTarget()
    }

    /// Route the pending tap: drop it when the host is no longer stored,
    /// switch to another stored host, wait for the selected host's first
    /// view, then open its conversation exactly once.
    func advancePushTarget() {
        guard hostsLoaded, let target = pendingPush else { return }
        let action = pushTargetAction(
            target,
            storedHostKeys: Set(hosts.hosts.map(\.hostKey)),
            currentHostKey: currentHostKey,
            hostReady: connected && snapshot != nil)
        switch action {
        case .drop:
            pendingPush = nil
        case .wait:
            break
        case .switchHost(let hostKey):
            switchHost(hostKey)
        case .open(let conversationId):
            pendingPush = nil
            navPath = [.conversation(conversationId)]
            openConversation(conversationId)
        }
    }

    /// Register or clear this device for the current host at one of the
    /// occasions ADR-0025 §9 lists. A failed request leaves its reason by
    /// the switch and is tried again at the next occasion.
    func syncPushToken() {
        if pushSyncInFlight {
            pushSyncPending = true
            return
        }
        guard phase == .connected, let host = sessionHost, let session,
              let snapshot, snapshot.connection == .connected, !snapshot.unauthorized,
              let hostMinor = snapshot.host?.protocol.minor
        else { return }

        let action = pushRegistrationAction(
            enabled: push.isEnabled(for: host.hostKey),
            hostMinor: hostMinor,
            deviceToken: push.deviceToken,
            environment: push.environment)
        let token: ApnsPushToken?
        switch action {
        case .none:
            return
        case .register(let value):
            token = value
        case .unregister:
            token = nil
        }

        pushSyncInFlight = true
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await session.invoke(.setPushToken(token: token))
                if self.currentHostKey == host.hostKey { self.pushError = nil }
            } catch {
                if self.currentHostKey == host.hostKey {
                    self.pushError = self.describe(error)
                }
            }
            self.pushSyncInFlight = false
            if self.pushSyncPending {
                self.pushSyncPending = false
                self.syncPushToken()
            }
        }
    }
}
