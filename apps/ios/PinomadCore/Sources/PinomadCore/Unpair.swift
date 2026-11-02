import Foundation

/// Unpair this device from a host. A pairing lives at both ends, so while
/// the host is reachable (`revoke`) ask it to drop this device's key first —
/// a refusal arrives as the host's notice — then forget the host here either
/// way. A failed call (the session ending under it, a timeout) still forgets
/// here. Without `revoke` only this end goes, and the host keeps listing the
/// device until it is unpaired there.
public func unpairHost(
    revoke: (@Sendable () async throws -> Void)?,
    forget: @Sendable () async -> Void
) async {
    if let revoke { try? await revoke() }
    await forget()
}
