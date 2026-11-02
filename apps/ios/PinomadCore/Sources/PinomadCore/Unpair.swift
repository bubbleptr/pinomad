import Foundation

/// Unpair this device from a host. A pairing lives at both ends, so while
/// the host is reachable (`revoke`) ask it to drop this device's key first,
/// then forget the host here either way. A failed call (a timeout, the
/// session ending under it) still forgets here.
///
/// `forget` hears whether the host answered. It didn't when there was no
/// `revoke` or the call threw. In that case the host may still list this
/// device and hold its push registration until it is unpaired there.
/// "Answered" does not mean "revoked": `revokeDevice` is a command-class
/// call, so the core turns a host refusal or a connection lost mid-call into
/// a notice, and the call itself still succeeds.
public func unpairHost(
    revoke: (@Sendable () async throws -> Void)?,
    forget: @Sendable (_ hostAnswered: Bool) async -> Void
) async {
    var answered = false
    if let revoke {
        answered = (try? await revoke()) != nil
    }
    await forget(answered)
}
