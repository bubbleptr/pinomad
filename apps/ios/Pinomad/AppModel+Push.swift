import Foundation
import PinomadCore

/// The push switch and tapped notifications. The decisions themselves live
/// in `PinomadCore.Push`; this is the thin per-host assembly.
extension AppModel {
    /// The app-level switch; every connected host follows it.
    var pushEnabled: Bool {
        push.isEnabled
    }

    /// The reader flipped the switch: ask for permission the first time it is
    /// turned on, then register or clear every connected host. Hosts that are
    /// still connecting catch up when they become ready.
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

    /// Route the pending tap: drop it when the host is no longer paired,
    /// wait for that host's first view, then open its conversation exactly
    /// once — the screen moves only then, straight to it (#429).
    func advancePushTarget() {
        guard hostsLoaded, let target = pendingPush else { return }
        var storedHostKeys = Set(hosts.hosts.map(\.hostKey))
        storedHostKeys.formUnion(unsavedHostKeys)
        let runtime = runtimes[target.hostKey] ?? (pairingRuntime?.hostKey == target.hostKey
            ? pairingRuntime : nil)
        let action = pushTargetAction(
            target,
            storedHostKeys: storedHostKeys,
            hostReady: runtime?.isConnectedNow == true && runtime?.snapshot != nil)
        switch action {
        case .drop:
            pendingPush = nil
        case .wait:
            break
        case .open(let ref):
            pendingPush = nil
            navPath = [.conversation(ref)]
            openConversation(ref)
        }
    }

    /// The banner baseline is the conversation actually visible, not just
    /// the app being in the foreground (ADR-0035 §9).
    func updatePushVisibility() {
        guard let runtime = focusedRuntime, runtime.isConnectedNow else {
            push.visibleConversation = nil
            return
        }
        push.visibleConversation = runtimeTable.focus?.conversation
    }

    /// Register or clear this device on every connected host at one of the
    /// occasions ADR-0025 §9 lists. Each host has its own in-flight slot, so
    /// a slow or failing host never stalls another.
    func syncPushToken() {
        for runtime in runtimes.values { syncPushToken(for: runtime) }
    }

    func syncPushToken(for runtime: HostRuntime) {
        guard let hostKey = runtime.hostKey,
              runtime.phase == .connected,
              runtime.isConnectedNow,
              let snapshot = runtime.snapshot,
              !snapshot.unauthorized,
              let hostMinor = snapshot.host?.protocol.minor,
              !forgettingHosts.contains(hostKey)
        else { return }

        if pushSyncInFlight.contains(hostKey) {
            pushSyncPending.insert(hostKey)
            return
        }

        let action = pushRegistrationAction(
            enabled: push.isEnabled,
            mayHaveRegistration: push.mayHaveRegistration(for: hostKey),
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
        // register whose reply (or this process) never comes back.
        if registering, !forgettingHosts.contains(hostKey) {
            push.setMayHaveRegistration(true, for: hostKey)
        }
        pushSyncInFlight.insert(hostKey)
        guard let session = runtime.session else {
            pushSyncInFlight.remove(hostKey)
            return
        }
        Task { [weak self, weak runtime] in
            guard let self else { return }
            do {
                _ = try await session.invoke(.setPushToken(token: token))
                if !registering, !self.forgettingHosts.contains(hostKey),
                   self.hosts.hosts.contains(where: { $0.hostKey == hostKey })
                    || self.unsavedHostKeys.contains(hostKey) {
                    self.push.setMayHaveRegistration(false, for: hostKey)
                }
                if self.currentHostKey == hostKey { self.pushError = nil }
            } catch {
                if self.currentHostKey == hostKey {
                    self.pushError = self.describe(error)
                }
            }
            self.pushSyncInFlight.remove(hostKey)
            if self.pushSyncPending.remove(hostKey) != nil, let runtime {
                self.syncPushToken(for: runtime)
            }
        }
    }
}
