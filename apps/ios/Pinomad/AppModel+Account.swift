import Foundation
import PinomadCore
import UIKit

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
                // A notice the last run found but never got to show (#497).
                if let session = record.session {
                    newHostNotices = knownAccountHosts.pending(
                        serverOrigin: session.serverOrigin, username: session.username)
                }
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
        // The model, not UIDevice.name: that one is the owner's own label
        // ("Kieran's iPhone") and would be personal data on the server.
        let device = AccountDeviceClaim(id: accountDeviceIds.id(), name: UIDevice.current.model)
        switch await api.login(username: user, password: password, device: device) {
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
            let record = AccountRecord(session: session, admin: value.admin)
            // A new account starts a new registration epoch; work started
            // for the previous session must not land on this one.
            invalidateAccountPairing()
            accountRecord = record
            accountNotice = nil
            accountSignOutWarning = nil
            accountError = nil
            accountHostsError = nil
            accountHostsLoaded = false
            clearAccountDevices()
            // The first list of this sign-in is the baseline: hosts already
            // on the account aren't news (#497).
            knownAccountHosts.reset(serverOrigin: session.serverOrigin, username: session.username)
            var saveError: String?
            do {
                try accountStore.save(record)
            } catch {
                saveError = "Signed in, but the account couldn't be saved to the keychain: \(describe(error))"
            }
            syncServerPushToken()
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
            #if DEBUG
            // A demo account keeps the rows it was given.
            if devHostsInjected, accountSession != nil { return }
            #endif
            accountRows = []
            accountHostsLoaded = false
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
            accountHostsLoaded = true
            announceNewHosts(result.rows, session: session)
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
            let account = AccountLink(serverOrigin: session.serverOrigin, hostId: hostId, vouched: true)
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
    ///
    /// `revoke` (a shared iPhone, #494; plain sign-out only) also asks the
    /// server to have every host this device joined through the account
    /// revoke it, and forgets the stored hosts linked to that server. The
    /// forgetting doesn't depend on the answer: an older server ignores
    /// `revoke` and still answers 204, and without the hosts' keys this
    /// device can't connect back either way. QR-paired hosts stay.
    func accountSignOut(everywhere: Bool, revoke: Bool = false) async {
        let revoke = revoke && !everywhere
        guard let session = accountSession, let api = accountAPI() else { return }
        accountBusy = true
        serverPushPaused = true
        defer {
            accountBusy = false
            serverPushPaused = false
            // A token APNs issued while paused was dropped, not queued: catch
            // up now. After a sign-out there's no session, so this sends
            // nothing; a newer session that started meanwhile registers.
            syncServerPushToken()
        }
        accountSignOutWarning = nil
        let failure: AccountFailure?
        var pushRemoved = true
        if everywhere {
            // Revoking every session also clears the account's push tokens
            // on the server (ADR-0036 §5).
            switch await api.revokeAllSessions() {
            case .success:
                failure = nil
                push.setServerRegistration(serverRegistration(
                    afterServerDropped: ServerPushAccount(serverOrigin: session.serverOrigin, username: session.username),
                    recorded: push.serverRegistration))
            case .failure(let error): failure = error
            }
        } else {
            pushRemoved = await removeServerPushToken(
                api: api,
                account: ServerPushAccount(serverOrigin: session.serverOrigin, username: session.username))
            switch await api.logout(revoke: revoke) {
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
        // After the session ended, so no account refresh can register a
        // host again while it is being forgotten.
        if revoke { forgetAccountHosts(serverOrigin: session.serverOrigin) }
        let serverWarning = AccountCopy.signOutWarning(everywhere: everywhere, revoke: revoke, failure: failure)
        let pushWarning = pushRemoved ? nil
            : "The server didn't confirm removing this device's notification token, so hosts on the account may still notify it. Sign in again and turn notifications off to remove it."
        let joined = [warning, serverWarning, pushWarning].compactMap { $0 }.joined(separator: "\n")
        accountSignOutWarning = joined.isEmpty ? nil : joined
    }

    /// Forget every stored host linked to `serverOrigin`'s account, without
    /// declining it (#494). Hosts paired by QR code carry no link and stay.
    private func forgetAccountHosts(serverOrigin: String) {
        // Saved pairings, plus account pairings whose keychain write failed:
        // those live only in memory (a runtime, a retry slot) until saved.
        var candidates = hosts.hosts
        for key in unsavedHostKeys {
            if let host = runtimes[key]?.host { candidates.append(host) }
        }
        let unsavedOurs = AccountHosts.vouchedHostKeys(
            serverOrigin: serverOrigin, hosts: Array(unsavedAccountHosts.values))
        for (hostId, host) in unsavedAccountHosts where unsavedOurs.contains(host.hostKey) {
            unsavedAccountHosts.removeValue(forKey: hostId)
        }
        var keys: [String] = []
        for key in AccountHosts.vouchedHostKeys(serverOrigin: serverOrigin, hosts: candidates) + unsavedOurs
        where !keys.contains(key) && hostRecord(for: key) != nil {
            keys.append(key)
        }
        for key in keys { forget(key, decline: false) }
    }

    /// Change the account password (#450). This session stays; the server
    /// signs out the others and drops every push registration of the account,
    /// this device's included, so a success registers it again right away.
    func accountChangePassword(current: String, new: String) async -> AccountFailure? {
        guard let session = accountSession, let api = accountAPI() else {
            return AccountFailure(code: "unauthenticated")
        }
        switch await api.changePassword(current: current, new: new) {
        case .success:
            guard accountSession == session else { return nil }
            push.setServerRegistration(serverRegistration(
                afterServerDropped: ServerPushAccount(serverOrigin: session.serverOrigin, username: session.username),
                recorded: push.serverRegistration))
            syncServerPushToken()
            return nil
        case .failure(let failure):
            if failure.clearsSession, accountSession == session {
                accountSignOutWarning = endAccountSession(notice: AccountCopy.message(failure))
            }
            return failure
        }
    }

    /// Load the account's devices (#452). Only the latest ask lands, so a
    /// slow answer from before a removal can't bring the old list back.
    func accountRefreshDevices() async {
        guard let session = accountSession, let api = accountAPI() else { return }
        accountDevicesGeneration &+= 1
        let generation = accountDevicesGeneration
        let result = await api.listDevices()
        guard accountSession == session, generation == accountDevicesGeneration else { return }
        switch result {
        case .success(let devices):
            accountDevices = devices
            accountDevicesError = nil
            // A server upgraded since an earlier 404 shows the list again.
            accountDevicesUnsupported = false
        case .failure(let failure) where failure.status == 404:
            accountDevicesUnsupported = true
        case .failure(let failure) where failure.clearsSession:
            accountSignOutWarning = endAccountSession(notice: AccountCopy.message(failure))
        case .failure(let failure):
            accountDevicesError = AccountCopy.message(failure)
        }
    }

    /// Remove another device from the account and ask its hosts to revoke it
    /// (ADR-0037 §3), then reload the list to show where that stands.
    func accountKickDevice(_ device: AccountDevice, password: String) async -> AccountFailure? {
        guard let session = accountSession, let api = accountAPI() else {
            return AccountFailure(code: "unauthenticated")
        }
        let result = await api.kickDevice(id: device.id, password: password)
        guard accountSession == session else { return nil }
        switch result {
        case .success:
            await accountRefreshDevices()
            return nil
        case .failure(let failure) where failure.code == "not_found":
            // Already gone (removed from another device): the reload shows it.
            await accountRefreshDevices()
            return nil
        case .failure(let failure):
            if failure.clearsSession {
                accountSignOutWarning = endAccountSession(notice: AccountCopy.message(failure))
            }
            return failure
        }
    }

    /// Delete the account (#451). The server ends every session and drops
    /// the account's push registrations, this device's included, so the
    /// record goes too and nothing registers again: the session is gone.
    /// Paired hosts stay paired (ADR-0022 §6). A late success must not end a
    /// newer session.
    func accountDeleteAccount(password: String) async -> AccountFailure? {
        guard let session = accountSession, let api = accountAPI() else {
            return AccountFailure(code: "unauthenticated")
        }
        accountBusy = true
        // A register sent meanwhile could land after the deletion; let one
        // already in flight land first.
        serverPushPaused = true
        defer {
            accountBusy = false
            serverPushPaused = false
            // A token APNs issued while paused was dropped, not queued: catch
            // up now. After a deletion there's no session, so this sends
            // nothing; a newer session or a refused deletion registers.
            syncServerPushToken()
        }
        while let task = serverPushTask { await task.value }
        switch await api.deleteAccount(password: password) {
        case .success:
            push.setServerRegistration(serverRegistration(
                afterServerDropped: ServerPushAccount(serverOrigin: session.serverOrigin, username: session.username),
                recorded: push.serverRegistration))
            guard accountSession == session else { return nil }
            let warning = endAccountSession(notice: AccountCopy.accountDeletedNotice)
            // The username went with the account; the next sign-in keeps
            // only the server.
            rememberSignedOut(serverOrigin: session.serverOrigin, username: "")
            accountSignOutWarning = warning
            return nil
        case .failure(let failure):
            if failure.clearsSession, accountSession == session {
                accountSignOutWarning = endAccountSession(notice: AccountCopy.message(failure))
            }
            return failure
        }
    }

    func clearAccountDevices() {
        accountDevicesGeneration &+= 1
        accountDevices = nil
        accountDevicesError = nil
        accountDevicesUnsupported = false
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
                account: AccountLink(serverOrigin: session.serverOrigin, hostId: hostId, vouched: true),
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
                storedHostKey: row.storedHostKey,
                deviceReports: row.deviceReports)
        }
    }

    /// Forgetting a stored host leaves the account row for the same host
    /// unpaired, so the list doesn't offer to connect to a key that is gone.
    /// The declined set is written by the forget path before this runs;
    /// `decline: false` (a shared-device sign-out, #494) leaves it alone.
    func accountHostForgotten(_ hostKey: String, decline: Bool = true) {
        if let link = hostRecord(for: hostKey)?.account {
            if decline {
                declinedAccountHosts.add(serverOrigin: link.serverOrigin, hostId: link.hostId)
            }
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
                storedHostKey: nil,
                deviceReports: row.deviceReports)
        }
    }

    /// What the page with no stored host shows, and whether it keeps asking
    /// for the account's hosts (#493).
    var noHostHome: NoHostHome {
        NoHostHome(
            signedIn: accountSession != nil,
            accountHosts: accountHostsLoaded ? accountRows : nil,
            hostsError: accountHostsError)
    }

    /// Mint the first-host home's one-use join command (#493). A dead
    /// session signs out here like every other account call.
    func accountCreateJoinToken() async -> Result<JoinToken, AccountFailure> {
        #if DEBUG
        if devHostsInjected, accountSession != nil {
            let expiresAt = (Date.now.timeIntervalSince1970 + 600) * 1000
            return .success(JoinToken(
                token: "demo",
                expiresAt: expiresAt,
                command: "curl -fsSL https://pinomad.si/install.sh | sh -s -- join https://accounts.invalid 3f9c2a7e5b1d4c8a"))
        }
        #endif
        guard let session = accountSession, let api = accountAPI() else {
            return .failure(AccountFailure(code: "unauthenticated"))
        }
        let result = await api.createJoinToken()
        if case .failure(let failure) = result, failure.clearsSession, accountSession == session {
            accountSignOutWarning = endAccountSession(notice: AccountCopy.message(failure))
        }
        return result
    }

    /// The one-time notice for hosts that joined the account since this
    /// iPhone last looked (#497). A host joined through the account pairs
    /// with every device on its own, so this is where a phished join shows.
    /// It stays pending, across launches too, until the reader dismisses it.
    func announceNewHosts(_ rows: [AccountHostRow], session: AccountSession) {
        newHostNotices = knownAccountHosts.observe(
            serverOrigin: session.serverOrigin, username: session.username, hosts: rows)
    }

    /// The notice's text: every host still pending, in the order they joined.
    var newHostNotice: String? {
        newHostNotices.isEmpty ? nil : HostLinkCopy.newHostsNotice(newHostNotices.map(\.name))
    }

    /// The host waiting behind a code typed on this iPhone (#497).
    func accountLookupHostLink(_ code: String) async -> Result<HostLinkRequest, AccountFailure> {
        #if DEBUG
        if devHostsInjected, accountSession != nil { return await devHostLinkLookup(code) }
        #endif
        return await hostLinkCall { api in await api.lookupHostLink(userCode: code) }
    }

    /// Confirming here is the reader's own act, so this iPhone doesn't
    /// announce the host when it shows up; the join watch keeps refreshing
    /// until it is listed and paired, like any other account host.
    func accountConfirmHostLink(_ code: String, hostId: String) async -> Result<Void, AccountFailure> {
        guard let session = accountSession else { return .failure(AccountFailure(code: "unauthenticated")) }
        #if DEBUG
        if devHostsInjected {
            try? await Task.sleep(for: .milliseconds(400))
            return .success(())
        }
        #endif
        let result = await hostLinkCall { api in await api.confirmHostLink(userCode: code) }
        if case .success = result, accountSession == session {
            knownAccountHosts.add(serverOrigin: session.serverOrigin, username: session.username, hostId: hostId)
            newHostNotices.removeAll { $0.hostId == hostId }
            watchHostJoin(hostId, session: session)
        }
        return result
    }

    /// Refresh every few seconds until the host confirmed here is listed
    /// and paired with this iPhone (automatic registration runs on a
    /// refresh), for at most two minutes. The same watch serves the
    /// first-host home and Account → Add a Host; a newer confirm or the
    /// session ending cancels it.
    private func watchHostJoin(_ hostId: String, session: AccountSession) {
        hostJoinWatch?.cancel()
        hostJoinWatch = Task { [weak self] in
            _ = await HostJoinWatch.run(
                sleep: { try await Task.sleep(for: $0) },
                poll: { [weak self] in
                    guard let self, self.accountSession == session else { return .signedOut }
                    await self.accountRefreshHosts()
                    guard self.accountSession == session else { return .signedOut }
                    let paired = self.accountRows.contains { $0.hostId == hostId && $0.status == .paired }
                    return paired ? .paired : .waiting
                })
        }
    }

    /// The reader has seen the new-host notice: it isn't shown again.
    func dismissNewHostNotice() {
        let ids = newHostNotices.map(\.hostId)
        newHostNotices = []
        guard !ids.isEmpty, let session = accountSession else { return }
        knownAccountHosts.dismiss(serverOrigin: session.serverOrigin, username: session.username, hostIds: ids)
    }

    func accountDenyHostLink(_ code: String) async -> Result<Void, AccountFailure> {
        #if DEBUG
        if devHostsInjected, accountSession != nil { return .success(()) }
        #endif
        return await hostLinkCall { api in await api.denyHostLink(userCode: code) }
    }

    /// A dead session signs out here like every other account call.
    private func hostLinkCall<Value>(
        _ call: (AccountAPI) async -> Result<Value, AccountFailure>
    ) async -> Result<Value, AccountFailure> {
        guard let session = accountSession, let api = accountAPI() else {
            return .failure(AccountFailure(code: "unauthenticated"))
        }
        let result = await call(api)
        if case .failure(let failure) = result, failure.clearsSession, accountSession == session {
            accountSignOutWarning = endAccountSession(notice: AccountCopy.message(failure))
        }
        return result
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
    func endAccountSession(notice: String?) -> String? {
        guard let record = accountRecord else { return nil }
        let cleared = record.clearingToken()
        accountRecord = cleared
        accountRows = []
        accountHostsLoaded = false
        clearAccountDevices()
        accountHostsError = nil
        accountError = nil
        accountSignOutWarning = nil
        serverPushError = nil
        // Off screen only: the persisted notice goes with the next sign-in's
        // new baseline.
        newHostNotices = []
        hostJoinWatch?.cancel()
        hostJoinWatch = nil
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
