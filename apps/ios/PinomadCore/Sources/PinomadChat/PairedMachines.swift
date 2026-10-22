import PinomadCore

/// Every machine this device is paired with, in stored order — rows do not
/// jump when the connection moves — plus, first, a host a pairing just made
/// that the keychain failed to keep: the session is still that host's
/// device, so it must stay visible (and forgettable) until relaunch.
public func pairedMachines(stored: StoredHosts, session: HostRecord?) -> [HostRecord] {
    var machines = stored.hosts
    if let session, !machines.contains(where: { $0.hostKey == session.hostKey }) {
        machines.insert(session, at: 0)
    }
    return machines
}
