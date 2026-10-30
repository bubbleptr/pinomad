import Foundation
import OSLog
import PinomadChat
import PinomadCore

private let hostNameLogger = Logger(subsystem: "build.kieran.pinomad", category: "hosts")

/// The token clear did not come back in time — the host may have kept the
/// registration, so forgetting proceeds with the revocation warning.
struct PushUnregisterTimeout: Error {}

/// A pairing link waiting for the reader's go-ahead. `url` is where it
/// would connect, or nil when the link isn't a usable pairing link.
struct PendingPairing: Equatable {
    let link: String
    let target: PairingTarget?
}

/// Pairing entry points, labels and the explicit host switch. Connection
/// and forget lifecycles live on AppModel now that every host has a runtime.
extension AppModel {
    /// Label per stored host — its address, told apart by key when two
    /// hosts share one (e.g. behind the same relay).
    var hostLabels: [String: String] {
        Dictionary(
            PinomadCore.hostLabels(hosts: hosts.hosts.map(\.ffi)).map { ($0.hostKey, $0.label) },
            uniquingKeysWith: { first, _ in first })
    }

    /// Every paired machine in stored order — positions never jump when the
    /// focus moves — plus a host a pairing just made that the keychain
    /// failed to keep.
    var machines: [HostRecord] {
        pairedMachines(stored: hosts, session: sessionHost)
    }

    /// What every screen calls one machine.
    func machineLabel(_ hostKey: String) -> String {
        if let label = hostLabels[hostKey] { return label }
        guard let host = hostRecord(for: hostKey) else { return "Host" }
        return host.name ?? hostOf(host.url)
    }

    /// Every machine's roots in stored order, for the status tiles, search
    /// and the cross-machine lists (#429).
    var machineRoots: [MachineRoot] {
        machines.flatMap { host -> [MachineRoot] in
            guard let organized = runtimes[host.hostKey]?.snapshot?.organized else { return [] }
            return allRoots(organized).map {
                MachineRoot(hostKey: host.hostKey, node: $0.node, project: $0.project)
            }
        }
    }

    /// One host's connection state for the per-host rows (issue #428 §8).
    func connectionLabel(for hostKey: String) -> String {
        guard let runtime = runtimes[hostKey] else { return "Not connected" }
        switch runtime.phase {
        case .connecting: return "Connecting"
        case .connected: return runtime.isConnectedNow ? "Connected" : "Reconnecting"
        case .failed: return "Offline"
        }
    }

    /// What the screens call the focused host.
    var currentHostLabel: String? {
        if let host = sessionHost { return hostLabels[host.hostKey] ?? hostOf(host.url) }
        return pairingTarget.map { hostOf($0.url) }
    }

    /// Cache the machine name the connection announced on its settings
    /// stream. Keyed by the connection's host, never by the selected one; a
    /// nil/empty announcement (older host, stream not landed) keeps the
    /// cached name. The store's serialized update re-reads the keychain so a
    /// pairing or account write racing this one is not clobbered.
    func cacheHostName(_ announced: String?, for hostKey: String) {
        guard let announced, !announced.isEmpty,
              let entry = hosts.hosts.first(where: { $0.hostKey == hostKey }),
              entry.name != announced
        else { return }
        do {
            try store.update { stored in
                if let renamed = stored.settingName(announced, for: hostKey) {
                    stored = renamed
                }
            }
            reloadHosts()
        } catch {
            hostNameLogger.error("could not cache host name: \(String(describing: error), privacy: .public)")
        }
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

    /// Move the screen to another paired host without reconnecting it. The
    /// connection stays up and its session object is never rebuilt
    /// (issue #428 §8).
    func switchHost(_ hostKey: String) {
        #if DEBUG
        if devHostsInjected {
            showToast("Demo data: hosts don't switch.")
            return
        }
        #endif
        guard runtimeTable.contains(hostKey) else { return }
        focus(on: hostKey)
    }

    /// The host's one-time pairing offer for another device. Request-class:
    /// the host rejects with a message the sheet shows.
    func createPairingOffer() async -> Result<PairingCodeOffer, PairingCodeFailure> {
        guard let session else {
            return .failure(PairingCodeFailure(message: "Not connected to the host yet."))
        }
        do {
            switch try await session.invoke(.createPairing) {
            case .pairing(let url, let expiresAt):
                return .success(PairingCodeOffer(url: url, expiresAt: expiresAt))
            default:
                return .failure(PairingCodeFailure(message: "The host didn't return a pairing link."))
            }
        } catch {
            return .failure(PairingCodeFailure(message: describe(error)))
        }
    }
}

/// A one-time pairing URL and when it dies (epoch ms).
struct PairingCodeOffer: Equatable {
    let url: String
    let expiresAt: Double
}

struct PairingCodeFailure: Error, Equatable {
    let message: String
}

/// `host[:port]` of a URL, for "pair with …".
func hostOf(_ url: String) -> String {
    guard let components = URLComponents(string: url), let host = components.host else { return url }
    return components.port.map { "\(host):\($0)" } ?? host
}
