#if DEBUG
import Foundation
import PinomadCore

/// `PINOMAD_DEMO_SETTINGS=upgrade-<state>`: the About page over a 5.30
/// demo host. `available`, `crosses` (a new protocol major), `waiting`,
/// `installing`, `restarting` (installing, connection lost), `failed`,
/// `check-error`, `current`, `source`, `no-service`, `off` (checks off), and
/// `old` (a host from before the stream). Nothing is installed; the calls
/// have no session to go out on.
extension AppModel {
    func applyUpgradeDemo(_ mode: String, to snapshot: inout ClientSnapshot, now: Double) {
        let state = String(mode.dropFirst("upgrade-".count))
        if state == "old" { return }
        snapshot.host = HostInfo(version: "0.13.0", protocol: ProtocolVersion(major: 5, minor: 30))
        snapshot.settings?.autoUpgrade = state == "off" ? .off : .notify
        let release = AvailableUpgrade(
            version: "0.14.0", publishedAt: now - 2 * 86_400_000, crossesMajor: state == "crosses")
        var upgrade = HostUpgradeState(
            current: "0.13.0", available: release, blocked: nil, phase: .idle, target: nil, attempt: 0,
            checking: false, checkedAt: now - 20 * 60_000, checkError: nil, failure: nil)
        switch state {
        case "waiting":
            upgrade.phase = .waiting
            upgrade.target = "0.14.0"
            upgrade.attempt = 1
        case "installing", "restarting":
            upgrade.phase = .installing
            upgrade.target = "0.14.0"
            upgrade.attempt = 1
            if state == "restarting" { snapshot.connection = .reconnecting }
        case "failed":
            upgrade.attempt = 1
            upgrade.failure = UpgradeFailure(
                version: "0.14.0",
                message: "npm ERR! code EACCES\nnpm ERR! syscall rename\nnpm ERR! path /usr/local/lib/node_modules/pinomad",
                attempt: 1)
        case "check-error":
            upgrade.available = nil
            upgrade.checkError = "npm view exited with 1: getaddrinfo ENOTFOUND registry.npmjs.org"
        case "current", "off":
            upgrade.available = nil
            if state == "off" { upgrade.checkedAt = nil }
        case "source":
            upgrade.current = nil
            upgrade.available = nil
            upgrade.checkedAt = nil
            upgrade.blocked = .source
        case "no-service":
            upgrade.blocked = .noService
        default:
            break
        }
        snapshot.upgrade = upgrade
    }
}
#endif
