import Foundation
import PinomadCore

/// Account actions (ADR-0022): one server at a time, a bearer token in the
/// keychain, and the host list matched against this device's pairings. The
/// decisions live in PinomadCore's account layer; this extension is the thin
/// app wiring around them.
extension AppModel {
    var accountSession: AccountSession? { accountRecord?.session }

    /// The stored host whose snapshot said 4401 — only a stored host can
    /// carry an account link to repair.
    var revokedHost: HostRecord? {
        // sessionHost holds the record from connect time; adoption may have
        // added the account link to the keychain copy since. Prefer the
        // latest stored record so a 4401 can still be reported.
        guard let key = sessionHost?.hostKey ?? currentHostKey else { return nil }
        return hosts.hosts.first { $0.hostKey == key } ?? sessionHost
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
                    accountSignOutWarning = "登录已过期，但没能清除钥匙串里的令牌；重启 App 后可能仍保持登录。"
                }
                accountNotice = "登录已过期，请重新登录。"
            } else {
                accountRecord = record
            }
        } catch {
            accountRecord = nil
            accountNotice = "读取账号信息失败：\(describe(error))"
        }
    }

    func accountAPI() -> AccountAPI? {
        guard let session = accountSession else { return nil }
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
            accountRecord = record
            accountNotice = nil
            accountSignOutWarning = nil
            accountError = nil
            accountHostsError = nil
            var saveError: String?
            do {
                try accountStore.save(record)
            } catch {
                saveError = "登录成功，但账号信息没能存进钥匙串：\(describe(error))"
            }
            await accountRefreshHosts()
            if let saveError { accountError = saveError }
            return nil
        }
    }

    /// Load the account's hosts and reconcile them with the stored pairings.
    /// A stale answer (logout or another login meanwhile) is dropped.
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
                accountSignOutWarning = endAccountSession(notice: "登录已失效，请重新登录。")
            } else {
                accountHostsError = AccountCopy.message(failure)
            }
        case .success(let hosts):
            guard accountSession == session else { return }
            let stored = (try? store.load()) ?? StoredHosts()
            let result = AccountHosts.reconcile(
                serverOrigin: session.serverOrigin,
                hosts: hosts,
                stored: stored,
                rejectedHostKeys: accountRejectedHostKeys)
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
                            rejectedHostKeys: accountRejectedHostKeys).stored
                    }
                    reloadHosts()
                } catch {
                    // Bookkeeping only; the next refresh tries again.
                }
            }
            accountRows = result.rows
            accountHostsError = nil
        }
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
        guard accountSession == session else { return }
        var warning = endAccountSession(notice: nil)
        if let failure, !failure.clearsSession {
            let server = everywhere
                ? "其他设备可能还没退出；请重新登录后再试一次「在所有设备上退出」。"
                : "已在这台设备退出，但服务端没有确认；会话会在 30 天内自然过期。"
            warning = [warning, server].compactMap { $0 }.joined(separator: "\n")
        }
        accountSignOutWarning = warning
    }

    /// Pair one account host through a server-vouched offer, then the same
    /// IK handshake a QR link drives. Never retried implicitly.
    @discardableResult
    func pairViaAccount(hostId: String) async -> Bool {
        guard let session = accountSession, let api = accountAPI() else {
            accountError = "请先登录账号。"
            return false
        }
        guard !accountBusy else { return false }
        accountBusy = true
        accountPairingHostId = hostId
        accountError = nil
        defer {
            accountBusy = false
            accountPairingHostId = nil
        }

        switch await api.requestPairing(hostId: hostId) {
        case .failure(let failure):
            guard accountSession == session else { return false }
            if failure.clearsSession {
                accountSignOutWarning = endAccountSession(notice: "登录已失效，请重新登录。")
            } else {
                accountError = AccountCopy.message(failure)
            }
            return false
        case .success(let offer):
            guard accountSession == session else { return false }
            guard let link = accountPairingLink(offer: offer) else {
                accountError = AccountCopy.message(AccountFailure(code: "invalid_offer"))
                return false
            }
            return pair(
                link: link,
                account: AccountLink(serverOrigin: session.serverOrigin, hostId: hostId))
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
        guard let link = host.account,
              let session = accountSession,
              normalizeServerOrigin(origin: link.serverOrigin)
                == normalizeServerOrigin(origin: session.serverOrigin)
        else { return }
        accountRejectedHostKeys.insert(host.hostKey)
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
    func accountHostForgotten(_ hostKey: String) {
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

    /// After an explicit re-pair under a changed key, the old linked record
    /// can never connect again. Same cleanup as the web model.
    func pruneAccountPairing(link: AccountLink, keepingHostKey: String) {
        do {
            try store.update { stored in
                stored = AccountHosts.pruningStale(
                    stored,
                    serverOrigin: link.serverOrigin,
                    hostId: link.hostId,
                    keepingHostKey: keepingHostKey)
            }
            reloadHosts()
        } catch {
            lastError = "没能清理旧的配对记录：\(describe(error))"
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
        do {
            try accountStore.save(cleared)
            return nil
        } catch {
            // Last resort: drop the whole item. Either way, say so.
            do {
                try accountStore.clear()
                return nil
            } catch {
                return "账号已退出，但没能清除钥匙串里的令牌；重启 App 后可能仍保持登录。"
            }
        }
    }
}
