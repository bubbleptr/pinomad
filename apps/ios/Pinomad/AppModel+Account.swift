import Foundation
import PinomadCore

/// Account actions (ADR-0022): one server at a time, a bearer token in the
/// keychain, and the host list matched against this device's pairings. The
/// decisions live in PinomadCore's account layer; this extension is the app
/// wiring around them, including the per-account-host automatic registration
/// from ADR-0035 §5.
extension AppModel {
    var accountSession: AccountSession? { accountRecord?.session }

    /// The stored host whose snapshot said 4401 — only a stored host can
    /// carry an account link to repair.
    var revokedHost: HostRecord? {
        guard let key = currentHostKey else { return nil }
        return hostRecord(for: key) ?? sessionHost
    }

    func loadAccount() {
        do {
            guard var record = try accountStore.load() else {
                accountRecord = nil
                return
            }
            if let session = record.session, session.isExpired() {
                record = record.clearingToken()
                accountRecord = record
                do {
                    try accountStore.save(record)
                } catch {
                    accountSignOutWarning = "Your sign-in expired, but the token couldn't be removed from the keychain. You may still be signed in after the app restarts."
                }
                accountNotice = "Your sign-in expired. Sign in again."
            } else {
                accountRecord = record
            }
        } catch {
            accountRecord = nil
            accountNotice = "Couldn't read the account: \(describe(error))"
        }
    }

    func accountAPI() -> AccountAPI? {
        guard let session = accountSession else { return nil }
        #if DEBUG
        // A demo account has no server: every account call stops here.
        if devHostsInjected { return nil }
        #endif
        return AccountAPI(
            origin: session.serverOrigin,
            token: session.token,
            transport: accountTransport)
    }

    func probeAccountServer(_ origin: String) async -> AccountsProbe {
        await AccountProbe(transport: accountTransport).probe(origin: origin)
    }

    /// Sign in to `origin` and load its hosts. The origin is checked before
    /// any request leaves the device (TLS-only, loopback http excepted).
    @discardableResult
    func accountLogin(origin: String, username: String, password: String) async -> AccountFailure? {
        let server = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !server.isEmpty else {
            accountError = AccountCopy.message(AccountFailure(code: "origin_required"))
            return AccountFailure(code: "origin_required")
        }
        guard isSecureServerOrigin(origin: server) else {
            let failure = AccountFailure(code: "insecure_origin")
            accountError = AccountCopy.message(failure)
            return failure
        }

        accountBusy = true
        defer { accountBusy = false }
        let api = AccountAPI(origin: server, transport: accountTransport)
        switch await api.login(username: user, password: password) {
        case .failure(let failure):
            rememberSignedOut(serverOrigin: server, username: user)
            accountError = AccountCopy.message(failure)
            return failure
        case .success(let value):
            guard let token = value.token else {
                let failure = AccountFailure.invalidResponse
                accountError = AccountCopy.message(failure)
                return failure
            }
            let session = AccountSession(
                serverOrigin: normalizeServerOrigin(origin: server),
                username: value.user.username,
                token: token,
                expiresAt: value.expiresAt)
            let record = AccountRecord(session: session)
            // A new account starts a new registration epoch; work started
            // for the previous session must not land on this one.
            invalidateAccountPairing()
            accountRecord = record
            accountNotice = nil
            accountSignOutWarning = nil
            accountError = nil
            accountHostsError = nil
            var saveError: String?
            do {
                try accountStore.save(record)
            } catch {
                saveError = "Signed in, but the account couldn't be saved to the keychain: \(describe(error))"
            }
            await accountRefreshHosts()
            if let saveError { accountError = saveError }
            return nil
        }
    }

    /// Load the account's hosts and reconcile them with the stored pairings.
    /// A stale answer (logout or another login meanwhile) is dropped. A failed
    /// keychain read is reported and makes every host ineligible for automatic
    /// registration — it is not an empty list (ADR-0035 §5).
    func accountRefreshHosts() async {
        guard let session = accountSession, let api = accountAPI() else {
            accountRows = []
            return
        }
        if accountRefreshing {
            accountRefreshPending = true
            return
        }
        accountRefreshing = true
        defer {
            accountRefreshing = false
            if accountRefreshPending {
                accountRefreshPending = false
                Task { [weak self] in await self?.accountRefreshHosts() }
            }
        }

        switch await api.listHosts() {
        case .failure(let failure):
            guard accountSession == session else { return }
            if failure.clearsSession {
                accountSignOutWarning = endAccountSession(notice: "You were signed out. Sign in again.")
            } else {
                accountHostsError = AccountCopy.message(failure)
            }
        case .success(let hosts):
            guard accountSession == session else { return }
            var stored: StoredHosts
            let storedRead: Bool
            do {
                stored = try store.load()
                storedRead = true
            } catch {
                // Keep the last good list for display, but never auto-register
                // over a failed read.
                stored = hostsRecordFallback()
                storedRead = false
                accountHostsError = "Couldn't read the saved pairings: \(describe(error))"
            }
            if storedRead {
                retryUnsavedAccountHosts()
                // A recovered save changes the matches; use the fresh list so
                // the same host is not registered a second time this round.
                stored = (try? store.load()) ?? stored
            }
            let result = AccountHosts.reconcile(
                serverOrigin: session.serverOrigin,
                hosts: hosts,
                stored: stored,
                rejectedHostKeys: accountRejectedHostKeys,
                declined: declinedHostRefs(),
                storedRead: storedRead)
            if result.changed {
                // Adopting a pre-account pairing is bookkeeping, not a
                // pairing: a failed write just leaves it to the next refresh.
                // Re-reconcile inside the locked update so a pairing that
                // landed meanwhile keeps its fresh private key.
                do {
                    try store.update { current in
                        current = AccountHosts.reconcile(
                            serverOrigin: session.serverOrigin,
                            hosts: hosts,
                            stored: current,
                            rejectedHostKeys: accountRejectedHostKeys,
                            declined: declinedHostRefs(),
                            storedRead: true).stored
                    }
                    reloadHosts()
                } catch {
                    // Bookkeeping only; the next refresh tries again.
                }
            }
            accountRows = result.rows
            if storedRead { accountHostsError = nil }
            if storedRead {
                startAutomaticRegistrations(result, session: session)
            }
        }
    }

    /// The last good in-memory list, for display while the keychain read is
    /// failing. `storedRead: false` still bars automatic registration.
    private func hostsRecordFallback() -> StoredHosts {
        hosts
    }

    private func declinedHostRefs() -> [AccountHostRef] {
        declinedAccountHosts.list().map {
            AccountHostRef(serverOrigin: $0.serverOrigin, hostId: $0.hostId)
        }
    }

    /// Try to persist account-registered identities whose handshake succeeded
    /// but whose keychain write failed. This only retries the save — never a
    /// new key or a second host registration (ADR-0035 §5).
    private func retryUnsavedAccountHosts() {
        for hostId in Array(unsavedAccountHosts.keys) {
            guard let host = unsavedAccountHosts[hostId] else { continue }
            do {
                try store.update { stored in
                    guard !stored.hosts.contains(where: { $0.hostKey == host.hostKey }) else { return }
                    stored.hosts.append(host)
                }
                unsavedAccountHosts.removeValue(forKey: hostId)
            } catch {
                // Keep the slot for the next refresh.
            }
        }
        reloadHosts()
    }

    /// One automatic registration per hostId. A host the server says is
    /// offline or too old is skipped until a later refresh.
    private func startAutomaticRegistrations(
        _ reconciliation: AccountReconciliation, session: AccountSession
    ) {
        guard accountPairingHostId == nil else { return }
        for hostId in reconciliation.autoRegisterHostIds {
            guard !declinedAccountHosts.contains(
                serverOrigin: session.serverOrigin, hostId: hostId)
            else { continue }
            guard let row = reconciliation.rows.first(where: { $0.hostId == hostId }),
                  row.pairable
            else { continue }
            guard accountRegistrationInFlight.insert(hostId).inserted else { continue }
            Task { [weak self] in
                await self?.automaticRegister(hostId, session: session)
            }
        }
    }

    private func automaticRegister(_ hostId: String, session: AccountSession) async {
        guard accountSession == session, let api = accountAPI() else {
            accountRegistrationInFlight.remove(hostId)
            return
        }
        if let pending = unsavedAccountHosts[hostId] {
            do {
                try store.update { stored in
                    guard !stored.hosts.contains(where: { $0.hostKey == pending.hostKey }) else { return }
                    stored.hosts.append(pending)
                }
                unsavedAccountHosts.removeValue(forKey: hostId)
                reloadHosts()
                await accountRefreshHosts()
            } catch {
                // Save-only retry failed; keep the slot and try next refresh.
            }
            accountRegistrationInFlight.remove(hostId)
            return
        }

        let generation = accountPairingGeneration
        switch await api.requestPairing(hostId: hostId) {
        case .failure(let failure):
            guard accountSession == session, generation == accountPairingGeneration else {
                accountRegistrationInFlight.remove(hostId)
                return
            }
            if failure.clearsSession {
                accountRegistrationInFlight.remove(hostId)
                accountSignOutWarning = endAccountSession(notice: "You were signed out. Sign in again.")
                return
            }
            if isDeclinedAccountFailure(failure) {
                declinedAccountHosts.add(
                    serverOrigin: session.serverOrigin, hostId: hostId)
            }
        case .success(let offer):
            guard accountSession == session, generation == accountPairingGeneration,
                  !declinedAccountHosts.contains(
                    serverOrigin: session.serverOrigin, hostId: hostId)
            else {
                accountRegistrationInFlight.remove(hostId)
                return
            }
            guard let link = accountPairingLink(offer: offer) else {
                accountRegistrationInFlight.remove(hostId)
                return
            }
            let account = AccountLink(serverOrigin: session.serverOrigin, hostId: hostId)
            guard beginPairing(
                link: link, account: account, focus: false,
                autoRegisterHostId: hostId) != nil
            else {
                accountRegistrationInFlight.remove(hostId)
                return
            }
            // The handshake's .paired/.failure removes the in-flight slot.
            return
        }
        accountRegistrationInFlight.remove(hostId)
    }

    private func isDeclinedAccountFailure(_ failure: AccountFailure) -> Bool {
        failure.code == "pair_rejected" || failure.code == "disabled"
    }

    /// Signing out keeps the paired hosts; only the server's guarantee goes
    /// away (ADR-0022 §6). The local token is cleared even when the request
    /// never reaches the server.
    func accountSignOut(everywhere: Bool) async {
        guard let session = accountSession, let api = accountAPI() else { return }
        accountBusy = true
        defer { accountBusy = false }
        accountSignOutWarning = nil
        let failure: AccountFailure?
        if everywhere {
            switch await api.revokeAllSessions() {
            case .success: failure = nil
            case .failure(let error): failure = error
            }
        } else {
            switch await api.logout() {
            case .success: failure = nil
            case .failure(let error): failure = error
            }
        }
        // A concurrent refresh may have cleared this same session first;
        // that must not swallow a failed "everywhere" request.
        let keptIdentity = accountRecord?.serverOrigin == session.serverOrigin
            && accountRecord?.username == session.username
        guard accountSession == session || (accountSession == nil && keptIdentity) else { return }
        let warning = endAccountSession(notice: nil)
        let serverWarning = AccountCopy.signOutWarning(everywhere: everywhere, failure: failure)
        let joined = [warning, serverWarning].compactMap { $0 }.joined(separator: "\n")
        accountSignOutWarning = joined.isEmpty ? nil : joined
    }

    /// Pair one account host through a server-vouched offer, then the same
    /// IK handshake a QR link drives. The reader's explicit join removes a
    /// decline and wins over an automatic round already in flight.
    @discardableResult
    func pairViaAccount(hostId: String) async -> Bool {
        guard let session = accountSession, let api = accountAPI() else {
            accountError = "Sign in first."
            return false
        }
        guard !accountBusy else { return false }
        // An explicit join wins over an automatic round already in flight for
        // the same account host.
        pairingRegistry.finish(.automatic(hostId: hostId))
        if let runtime = automaticPairingRuntimes.removeValue(forKey: hostId) {
            runtime.close()
        }
        accountRegistrationInFlight.remove(hostId)
        accountPairingGeneration &+= 1
        let generation = accountPairingGeneration
        accountBusy = true
        accountPairingHostId = hostId
        accountError = nil
        declinedAccountHosts.remove(serverOrigin: session.serverOrigin, hostId: hostId)
        defer {
            // A connection or another pairing invalidated this ask while it
            // was waiting; that path already cleared the indicators.
            if generation == accountPairingGeneration {
                accountBusy = false
                accountPairingHostId = nil
            }
        }

        if let pending = unsavedAccountHosts[hostId] {
            do {
                try store.update { stored in
                    guard !stored.hosts.contains(where: { $0.hostKey == pending.hostKey }) else { return }
                    stored.hosts.append(pending)
                }
                unsavedAccountHosts.removeValue(forKey: hostId)
                reloadHosts()
                focus(on: pending.hostKey)
                await accountRefreshHosts()
                return true
            } catch {
                accountError = AccountCopy.message(AccountFailure(code: "pairing_not_saved"))
                return false
            }
        }

        switch await api.requestPairing(hostId: hostId) {
        case .failure(let failure):
            guard accountSession == session, generation == accountPairingGeneration else { return false }
            if failure.clearsSession {
                accountSignOutWarning = endAccountSession(notice: "You were signed out. Sign in again.")
            } else {
                if isDeclinedAccountFailure(failure) {
                    declinedAccountHosts.add(
                        serverOrigin: session.serverOrigin, hostId: hostId)
                }
                accountError = AccountCopy.message(failure)
            }
            return false
        case .success(let offer):
            guard accountSession == session, generation == accountPairingGeneration else { return false }
            guard let link = accountPairingLink(offer: offer) else {
                accountError = AccountCopy.message(AccountFailure(code: "invalid_offer"))
                return false
            }
            return beginPairing(
                link: link,
                account: AccountLink(serverOrigin: session.serverOrigin, hostId: hostId),
                focus: true,
                autoRegisterHostId: nil) != nil
        }
    }

    /// Make any in-flight account pairing ask stale. A connection the reader
    /// chose while it waited wins; the late offer must not steal it.
    func invalidateAccountPairing() {
        accountPairingGeneration &+= 1
        for (hostId, runtime) in automaticPairingRuntimes {
            pairingRegistry.finish(.automatic(hostId: hostId))
            runtime.close()
        }
        automaticPairingRuntimes.removeAll()
        accountRegistrationInFlight.removeAll()
        if accountPairingHostId != nil {
            accountPairingHostId = nil
            accountBusy = false
        }
    }

    /// The explicit repair beside the 4401 page's "use a new pairing link"
    /// hint. Only offered when this stored host carries an account link to
    /// the server that is signed in now.
    func accountHostId(for hostKey: String) -> String? {
        guard let host = hosts.hosts.first(where: { $0.hostKey == hostKey }),
              let link = host.account,
              let session = accountSession,
              normalizeServerOrigin(origin: link.serverOrigin)
                == normalizeServerOrigin(origin: session.serverOrigin)
        else { return nil }
        return link.hostId
    }

    func repairViaAccount(hostKey: String) {
        guard let hostId = accountHostId(for: hostKey) else { return }
        Task { [weak self] in
            _ = await self?.pairViaAccount(hostId: hostId)
        }
    }

    /// A 4401 only marks the stored pairing. Asking for an invite is the
    /// reader's explicit action, never something this hook does.
    func markAccountRejected(_ host: HostRecord) {
        accountRejectedHostKeys.insert(host.hostKey)
        guard let link = host.account,
              let session = accountSession,
              normalizeServerOrigin(origin: link.serverOrigin)
                == normalizeServerOrigin(origin: session.serverOrigin)
        else { return }
        accountRows = accountRows.map { row in
            guard row.storedHostKey == host.hostKey else { return row }
            return AccountHostRow(
                hostId: row.hostId,
                name: row.name,
                online: row.online,
                pairing: row.pairing,
                status: .rejected,
                action: .rePair,
                storedHostKey: row.storedHostKey)
        }
    }

    /// Forgetting a stored host leaves the account row for the same host
    /// unpaired, so the list doesn't offer to connect to a key that is gone.
    /// The declined set is written by the forget path before this runs.
    func accountHostForgotten(_ hostKey: String) {
        if let link = hostRecord(for: hostKey)?.account {
            declinedAccountHosts.add(serverOrigin: link.serverOrigin, hostId: link.hostId)
            unsavedAccountHosts.removeValue(forKey: link.hostId)
            accountRegistrationInFlight.remove(link.hostId)
        }
        accountRejectedHostKeys.remove(hostKey)
        accountRows = accountRows.map { row in
            guard row.storedHostKey == hostKey else { return row }
            return AccountHostRow(
                hostId: row.hostId,
                name: row.name,
                online: row.online,
                pairing: row.pairing,
                status: .unpaired,
                action: .pair,
                storedHostKey: nil)
        }
    }

    /// Refresh the host list and the account list together — pull-to-refresh
    /// and the hosts sheet's first appearance.
    func refreshHostsAndAccount() async {
        reloadHosts()
        await accountRefreshHosts()
    }

    /// A pair handshake may land after a list refresh started; ask for one
    /// more pass so the new pairing shows up immediately.
    func accountRefreshAfterPairing() {
        guard accountSession != nil else { return }
        if accountRefreshing {
            accountRefreshPending = true
        } else {
            Task { [weak self] in await self?.accountRefreshHosts() }
        }
    }

    private func rememberSignedOut(serverOrigin: String, username: String) {
        let record = AccountRecord(
            serverOrigin: normalizeServerOrigin(origin: serverOrigin),
            username: username)
        accountRecord = record
        try? accountStore.save(record)
    }

    /// Clears the in-memory session and the keychain token. Returns a warning
    /// when the keychain still holds the token — the next launch would sign
    /// the reader back in despite this screen saying they are out.
    private func endAccountSession(notice: String?) -> String? {
        guard let record = accountRecord else { return nil }
        let cleared = record.clearingToken()
        accountRecord = cleared
        accountRows = []
        accountHostsError = nil
        accountError = nil
        accountSignOutWarning = nil
        accountNotice = notice
        // In-flight registrations belong to the session that just ended.
        accountPairingGeneration &+= 1
        accountRegistrationInFlight.removeAll()
        for (hostId, runtime) in automaticPairingRuntimes {
            pairingRegistry.finish(.automatic(hostId: hostId))
            runtime.close()
        }
        automaticPairingRuntimes.removeAll()
        do {
            try accountStore.save(cleared)
            return nil
        } catch {
            // Last resort: drop the whole item. Either way, say so.
            do {
                try accountStore.clear()
                return nil
            } catch {
                return "Signed out, but the token couldn't be removed from the keychain. You may still be signed in after the app restarts."
            }
        }
    }
}
