#if DEBUG
import Foundation
import PinomadCore

/// `PINOMAD_DEMO_SETTINGS`: the settings pages without a host — two paired
/// machines (the first connected, renamed, with three devices, this one
/// among them), a chat, and one archived root. `failed`
/// fails the first machine and opens its failure page; `pairing` the first-run
/// page with nothing paired; `first-host` the same, signed in to an account
/// with no hosts (#493), and `first-host-…` its host-link demos (#497);
/// `account` adds a signed-in account (its calls
/// never leave the app); `signed-out` only the remembered account a sign-out
/// leaves behind, with no session. The addresses are
/// `.invalid` and the injected hosts block switching and forgetting, so
/// nothing reaches the keychain or the network.
extension AppModel {
    func startSettingsDemo(_ mode: String) {
        if mode == "pairing" {
            useDevHosts(StoredHosts(hosts: [], activeHostKey: nil))
            phase = .pairing
            return
        }
        if mode == "first-host" || mode.hasPrefix("first-host-") {
            useDevHosts(StoredHosts(hosts: [], activeHostKey: nil))
            let record = AccountRecord(
                serverOrigin: "https://accounts.invalid", username: "kieran",
                token: "demo", expiresAt: Date.now.addingTimeInterval(86_400).timeIntervalSince1970 * 1000)
            accountRecord = record
            accountRows = []
            accountHostsLoaded = true
            phase = .pairing
            startHostLinkDemo(mode, session: record.session!)
            return
        }
        // A fixed key, so the devices list can mark this device.
        let privateKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        useDevHosts(StoredHosts(
            hosts: [
                HostRecord(url: "ws://mbp.invalid:7777", hostKey: "demo-mbp", privateKey: privateKey, name: "mbp"),
                HostRecord(url: "ws://omarchy.invalid:7777", hostKey: "demo-omarchy", privateKey: "", name: "omarchy"),
            ],
            activeHostKey: "demo-mbp"
        ))
        if mode == "account" {
            accountRecord = AccountRecord(
                serverOrigin: "https://accounts.invalid", username: "kieran",
                token: "demo", expiresAt: Date.now.addingTimeInterval(86_400).timeIntervalSince1970 * 1000)
            startAccountDevicesDemo()
        }
        if mode == "signed-out" {
            accountRecord = AccountRecord(serverOrigin: "https://accounts.invalid", username: "kieran")
        }
        if mode == "failed" {
            failDevHost("demo-mbp", .unreachable("Couldn't reach mbp.invalid:7777."))
            phase = .home
            navPath = [.machineUnavailable("demo-mbp")]
            return
        }
        let now = Date.now.timeIntervalSince1970 * 1000
        func summary(_ id: UInt64, _ title: String, ago minutes: Double) -> ConversationSummary {
            ConversationSummary(
                id: id, kind: .conversation, parent: nil, forkedAt: nil, title: title, status: nil,
                updatedAt: now - minutes * 60_000, label: nil, role: nil, activity: nil
            )
        }
        let organized = Organized(
            chats: [ConversationNode(summary: summary(1, "Draft the weekly report", ago: 2), children: [])],
            projects: [],
            archived: [
                ArchivedConversation(
                    node: ConversationNode(summary: summary(40, "Old pairing flow", ago: 9_000), children: []),
                    project: Project(path: "/Users/void/code/opensource/pinomad", name: "pinomad", addedAt: now)),
            ]
        )
        phase = .home
        publishDevSnapshot(ClientSnapshot(
            version: 1, connection: .connected, unauthorized: false,
            protocolMismatch: nil, host: HostInfo(version: "0.9.0", protocol: ProtocolVersion(major: 5, minor: 14)),
            hostName: "studio",
            settings: HostSettingsState(acceptAccountDevices: true, hostNameCustom: true),
            devices: [
                DeviceEntry(publicKey: devicePublicKey(privateKey: privateKey) ?? "", name: "iPhone",
                            pairedAt: now - 3 * 86_400_000, source: .qr),
                DeviceEntry(publicKey: "demo-mac", name: "Kieran's MacBook", pairedAt: now - 40 * 86_400_000,
                            source: .local),
                DeviceEntry(publicKey: "demo-ipad", name: "iPad", pairedAt: now - 2 * 3_600_000, source: .account),
            ],
            organized: organized,
            notices: [], models: [], defaults: Defaults(model: nil, thinkingLevel: nil),
            agents: nil, conversation: nil
        ))
    }

    /// The host-link demos (#497) over the first-host home: `first-host-confirm`
    /// types a code and opens its confirm page, `first-host-ip` one asked
    /// from another address, `first-host-joined` confirms it, and
    /// `first-host-notice` has a host join from elsewhere a moment later.
    private func startHostLinkDemo(_ mode: String, session: AccountSession) {
        knownAccountHosts.reset(serverOrigin: session.serverOrigin, username: session.username)
        announceNewHosts([], session: session)
        switch mode {
        case "first-host-confirm": devHostLinkCode = "kxhn bwcv"
        case "first-host-ip": devHostLinkCode = "qrst-vwxz"
        case "first-host-joined":
            devHostLinkCode = "kxhnbwcv"
            devHostLinkConfirms = true
        case "first-host-notice":
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard let self, self.accountSession == session else { return }
                let rows = [AccountHostRow(
                    hostId: "demo-studio", name: "studio", online: true, pairing: .available,
                    status: .unpaired, action: .pair, storedHostKey: nil)]
                self.accountRows = rows
                self.announceNewHosts(rows, session: session)
            }
        default: break
        }
    }

    /// Two codes are waiting: KXHN-BWCV from this iPhone's network and
    /// QRST-VWXZ from another one. Any other code isn't.
    func devHostLinkLookup(_ code: String) async -> Result<HostLinkRequest, AccountFailure> {
        try? await Task.sleep(for: .milliseconds(400))
        let expiresAt = (Date.now.timeIntervalSince1970 + 9 * 60 + 12) * 1000
        switch code {
        case "KXHNBWCV":
            return .success(HostLinkRequest(
                hostId: "Kx3f9Q2aZ8mN1pLr5tVw7yB0cD4eF6gH8iJ0kL2mN4o", name: "studio", os: "macOS 26.1",
                sourceIp: "203.0.113.7", ipDiffers: false, expiresAt: expiresAt))
        case "QRSTVWXZ":
            return .success(HostLinkRequest(
                hostId: "Pq7RsT1uVw3XyZ5aBc7De9Fg1Hi3Jk5Lm7No9Pq1Rs3", name: "build-box", os: "Linux 6.8 (x64)",
                sourceIp: "198.51.100.23", ipDiffers: true, expiresAt: expiresAt))
        default:
            return .failure(AccountFailure(code: "not_found", status: 404))
        }
    }

    /// The account's hosts and devices (#452): this iPhone, a Mac whose
    /// removal one host hasn't confirmed, a removed iPad, and an old app's
    /// nameless entry. `old-host` doesn't report devices, so the Remove
    /// form names it.
    private func startAccountDevicesDemo() {
        let now = Date.now.timeIntervalSince1970 * 1000
        let minute = 60_000.0
        accountRows = [
            AccountHostRow(
                hostId: "demo-mbp", name: "mbp", online: true, pairing: .available, status: .paired,
                action: .connect(hostKey: "demo-mbp"), storedHostKey: "demo-mbp", deviceReports: true),
            AccountHostRow(
                hostId: "demo-old", name: "old-host", online: false, pairing: .offline, status: .unpaired,
                action: .pair, storedHostKey: nil, deviceReports: false),
        ]
        accountDevices = [
            AccountDevice(
                id: 3, name: "iPhone", createdAt: now - 9 * 86_400_000, lastSeenAt: now - 5 * minute,
                current: true, kickedAt: nil,
                hosts: [AccountDeviceHost(hostId: "demo-mbp", name: "mbp", state: .registered)]),
            AccountDevice(
                id: 4, name: "Mac Desktop", createdAt: now - 30 * 86_400_000, lastSeenAt: now - 2 * 86_400_000,
                current: false, kickedAt: nil,
                hosts: [
                    AccountDeviceHost(hostId: "demo-mbp", name: "mbp", state: .registered),
                    AccountDeviceHost(hostId: "demo-studio", name: "studio", state: .revoking),
                ]),
            AccountDevice(
                id: 2, name: "iPad", createdAt: now - 60 * 86_400_000, lastSeenAt: now - 20 * 86_400_000,
                current: false, kickedAt: now - 3 * 86_400_000,
                hosts: [AccountDeviceHost(hostId: "demo-mbp", name: "mbp", state: .revoked)]),
            AccountDevice(
                id: 1, name: nil, createdAt: now - 90 * 86_400_000, lastSeenAt: now - 45 * 86_400_000,
                current: false, kickedAt: nil, hosts: []),
        ]
    }
}
#endif
