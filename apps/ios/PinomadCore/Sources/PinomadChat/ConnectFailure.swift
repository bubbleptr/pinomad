import PinomadCore

/// Why a host can't be used — each case has its own way out on the failure
/// screen (a fresh link, forgetting the host, updating one side, retrying).
public enum ConnectFailure: Equatable, Sendable {
    /// The pairing link's one-time code was refused: used, or expired.
    case pairingRefused
    /// The host rejected this device's stored pairing, or revoked it.
    case revoked
    /// The host speaks a newer protocol major — update the app.
    case appOutdated(hostMajor: Double, clientMajor: Double)
    /// The host speaks an older protocol major — upgrade the host.
    case hostOutdated(hostMajor: Double, clientMajor: Double)
    /// Couldn't reach the host (or set up the session) at all.
    case unreachable(String)

    /// How the first connect ended; `pairing` is whether it used a link.
    public init?(outcome: ReadyOutcome, pairing: Bool) {
        switch outcome {
        case .connected:
            return nil
        case .unauthorized:
            self = pairing ? .pairingRefused : .revoked
        case .mismatch(let hostMajor, let clientMajor, let direction, _):
            self = Self.mismatch(hostMajor: hostMajor, clientMajor: clientMajor, direction: direction)
        case .error(let message):
            self = .unreachable(message)
        }
    }

    /// A live session's terminal states: the host revoked the device
    /// (4401 after the first view) or a hello announced another major.
    public init?(snapshot: ClientSnapshot) {
        if snapshot.unauthorized {
            self = .revoked
        } else if let mismatch = snapshot.protocolMismatch {
            self = Self.mismatch(
                hostMajor: mismatch.hostMajor, clientMajor: mismatch.clientMajor,
                direction: mismatch.direction)
        } else {
            return nil
        }
    }

    private static func mismatch(hostMajor: Double, clientMajor: Double, direction: String) -> Self {
        direction == "host-older"
            ? .hostOutdated(hostMajor: hostMajor, clientMajor: clientMajor)
            : .appOutdated(hostMajor: hostMajor, clientMajor: clientMajor)
    }
}
