import Foundation
import PinomadCore

/// The push switch and tapped notifications. The decisions themselves live
/// in `PinomadCore.Push`; this is the thin session/UI assembly.
extension AppModel {
    /// The app-level switch; every connected host follows it.
    var pushEnabled: Bool {
        push.isEnabled
    }

    /// The reader flipped the switch: ask for permission the first time it is
    /// turned on, then register or clear the connected host. Other hosts
    /// catch up on their next connection.
    func setPushEnabled(_ enabled: Bool) {
        push.setEnabled(enabled)
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
    /// occasions ADR-0025 §9 lists. The switch is app-wide, so the same
    /// value applies to every host; only the connected one can act on it now.
    /// A failed request leaves its reason by the switch and is tried again
    /// at the next occasion.
    func syncPushToken() {
        if pushSyncInFlight {
            pushSyncPending = true
            return
        }
        guard phase == .connected, let host = sessionHost, let session,
              let snapshot, snapshot.connection == .connected, !snapshot.unauthorized,
              let hostMinor = snapshot.host?.protocol.minor,
              !forgettingHosts.contains(host.hostKey)
        else { return }

        let action = pushRegistrationAction(
            enabled: push.isEnabled,
            mayHaveRegistration: push.mayHaveRegistration(for: host.hostKey),
            hostMinor: hostMinor,
            deviceToken: push.deviceToken,
            environment: push.environment)
        let token: ApnsPushToken?
        let registering: Bool
        switch action {
        case .none:
            return
        case .register(let value):
            token = value
            registering = true
        case .unregister:
            token = nil
            registering = false
        }

        // Remember the attempt before it goes out: a host may accept a
        // register whose reply (or this process) never comes back. Only a
        // successful clear is proof that nothing is registered.
        if registering, !forgettingHosts.contains(host.hostKey) {
            push.setMayHaveRegistration(true, for: host.hostKey)
        }
        pushSyncInFlight = true
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await session.invoke(.setPushToken(token: token))
                // A host being forgotten owns the clearing request; a
                // late clear must not resurrect or drop its flag.
                if !registering, !self.forgettingHosts.contains(host.hostKey),
                   self.hosts.hosts.contains(where: { $0.hostKey == host.hostKey }) {
                    self.push.setMayHaveRegistration(false, for: host.hostKey)
                }
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
