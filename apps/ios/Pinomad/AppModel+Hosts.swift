import Foundation
import PinomadChat
import PinomadCore

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
        if let key = currentHostKey, let label = hostLabels[key] { return label }
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

    /// Back out of a failed pairing to the host the device used before
    /// (the keychain only changes once a pairing succeeds).
    func cancelPairing() {
        connectActive()
    }

    /// Try the same thing again — the link for a pairing, else the host.
    /// Also the manual reconnect for a closed session, which never
    /// retries on its own.
    func retryConnection() {
        if let link = pairingLink {
            pair(link: link)
        } else if let key = currentHostKey, let host = hosts.hosts.first(where: { $0.hostKey == key }) {
            connect(host)
        } else {
            connectActive()
        }
    }

    /// Make `hostKey` the launch host and connect to it.
    func switchHost(_ hostKey: String) {
        guard hostKey != currentHostKey || phase != .connected else { return }
        do {
            try store.save(hosts.activating(hostKey))
        } catch {
            // Still connect: only the next launch would open the old one.
            lastError = "没能记住所选宿主：\(describe(error))"
        }
        reloadHosts()
        if let host = hosts.hosts.first(where: { $0.hostKey == hostKey }) {
            connect(host)
        }
    }

    /// Drop `hostKey`'s pairing. Forgetting the host on screen moves to the
    /// next one (or to pairing when none is left).
    func forget(_ hostKey: String) {
        do {
            try store.save(hosts.forgetting(hostKey))
        } catch {
            lastError = "没能忘记这台宿主：\(describe(error))"
            return
        }
        if hostKey == currentHostKey {
            connectActive()
        } else {
            reloadHosts()
        }
    }
}

/// `host[:port]` of a URL, for "pair with …".
func hostOf(_ url: String) -> String {
    guard let components = URLComponents(string: url), let host = components.host else { return url }
    return components.port.map { "\(host):\($0)" } ?? host
}
