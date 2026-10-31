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

    /// Register or clear this device on every connected host, and with the
    /// account server, at one of the occasions ADR-0025 §9 lists. Each host
    /// has its own in-flight slot, so a slow or failing host never stalls
    /// another.
    func syncPushToken() {
        for runtime in runtimes.values { syncPushToken(for: runtime) }
        syncServerPushToken()
    }

    /// Keep the account server's record in step with the switch (ADR-0036):
    /// the server only delivers a host's push to a token recorded under the
    /// host's account. A failure waits for the next occasion.
    func syncServerPushToken() {
        guard !serverPushPaused, let session = accountSession, let api = accountAPI() else { return }
        if serverPushInFlight {
            serverPushPending = true
            return
        }
        let action = serverPushAction(
            enabled: push.isEnabled,
            serverOrigin: session.serverOrigin,
            deviceToken: push.deviceToken,
            environment: push.environment,
            recorded: push.serverRegistration)
        let send: () async -> Result<Void, AccountFailure>
        switch action {
        case .none:
            return
        case .register(let token):
            // Remember the attempt before it goes out, like the host flag.
            push.setServerRegistration(
                ServerPushRegistration(serverOrigin: session.serverOrigin, token: token))
            send = { await api.registerPushToken(token) }
        case .remove(let token):
            send = { await api.removePushToken(token) }
        }
        serverPushInFlight = true
        serverPushTask = Task { [weak self] in
            let result = await send()
            guard let self else { return }
            self.serverPushInFlight = false
            self.serverPushTask = nil
            if self.accountSession == session {
                switch result {
                case .success:
                    if case .remove(let token) = action {
                        self.forgetServerRegistration(token, serverOrigin: session.serverOrigin)
                    }
                    self.serverPushError = nil
                case .failure(let failure) where failure.clearsSession:
                    self.accountSignOutWarning = self.endAccountSession(
                        notice: "You were signed out. Sign in again.")
                case .failure(let failure):
                    self.serverPushError = AccountCopy.message(failure)
                }
            }
            if self.serverPushPending {
                self.serverPushPending = false
                self.syncServerPushToken()
            }
        }
    }

    /// Signing out removes the record while the bearer still works, after
    /// any register already in flight has landed (the caller pauses new
    /// ones). False when a recorded token could not be removed — the
    /// account's hosts may still reach this device.
    func removeServerPushToken(api: AccountAPI, serverOrigin: String) async -> Bool {
        while let task = serverPushTask { await task.value }
        guard case .remove(let token) = serverPushAction(
            enabled: false,
            serverOrigin: serverOrigin,
            deviceToken: nil,
            environment: push.environment,
            recorded: push.serverRegistration)
        else { return true }
        guard case .success = await api.removePushToken(token) else { return false }
        forgetServerRegistration(token, serverOrigin: serverOrigin)
        return true
    }

    /// Drop the record only if it is still the one just removed: a register
    /// queued meanwhile wrote a newer one.
    func forgetServerRegistration(_ token: ApnsPushToken, serverOrigin: String) {
        if push.serverRegistration == ServerPushRegistration(serverOrigin: serverOrigin, token: token) {
            push.setServerRegistration(nil)
        }
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
