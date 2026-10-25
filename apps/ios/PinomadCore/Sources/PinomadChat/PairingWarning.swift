import PinomadCore

/// The persistence warning a pairing produces, kept across later ready
/// outcomes so the failure page can still explain that the device key was
/// not saved. Ready success/failure never clears it; only a new session does.
public struct PairingWarningState: Equatable, Sendable {
    public private(set) var message: String?

    public init() {}

    public mutating func clear() {
        message = nil
    }

    public mutating func apply(_ update: SessionUpdate) {
        guard case .paired(_, let saveError) = update else { return }
        message = saveError.map {
            "Couldn't save this host (\($0)). After a restart the app returns to the previous host, and you'll need to pair again to use this one."
        }
    }
}
