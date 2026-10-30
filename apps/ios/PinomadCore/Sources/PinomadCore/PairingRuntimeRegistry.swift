import Foundation

/// What started one pairing runtime. A user-started pairing owns the screen;
/// an account registration runs in the background and never does.
public enum PairingRuntimeKind: Hashable, Sendable {
    case manual
    case automatic(hostId: String)
}

/// Tracks live pairing handshakes so a background registration can never
/// displace the manual pairing the reader is in the middle of (ADR-0035 §5).
public struct PairingRuntimeRegistry: Equatable, Sendable {
    private var manual = false
    private var automaticHostIds: Set<String> = []

    public init() {}

    public var isManualActive: Bool { manual }

    /// Only a manual pairing owns the screen; automatic registrations are
    /// background work.
    public var focusOwner: PairingRuntimeKind? {
        manual ? .manual : nil
    }

    public mutating func start(_ kind: PairingRuntimeKind) {
        switch kind {
        case .manual:
            manual = true
        case .automatic(let hostId):
            automaticHostIds.insert(hostId)
        }
    }

    public mutating func finish(_ kind: PairingRuntimeKind) {
        switch kind {
        case .manual:
            manual = false
        case .automatic(let hostId):
            automaticHostIds.remove(hostId)
        }
    }
}
