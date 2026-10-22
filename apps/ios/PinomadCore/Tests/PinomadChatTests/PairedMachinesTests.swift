import PinomadCore
import Testing
@testable import PinomadChat

private func host(_ key: String) -> HostRecord {
    HostRecord(url: "ws://\(key):7777", hostKey: key, privateKey: "")
}

/// The settings page lists every machine this device is paired with — the
/// keychain's list, plus the session's host when the keychain failed to
/// keep a fresh pairing (the device is still that host's device).
@Suite struct PairedMachinesTests {
    @Test func aSessionHostTheKeychainLostIsStillListed() {
        let stored = StoredHosts(hosts: [host("mbp")], activeHostKey: "mbp")
        let machines = pairedMachines(stored: stored, session: host("omarchy"))
        #expect(machines.map(\.hostKey) == ["omarchy", "mbp"])
    }

    /// Switching moves the session, not the rows.
    @Test func storedOrderStaysPutWhenTheSessionMoves() {
        let stored = StoredHosts(hosts: [host("mbp"), host("omarchy")], activeHostKey: "omarchy")
        #expect(pairedMachines(stored: stored, session: host("omarchy")).map(\.hostKey) == ["mbp", "omarchy"])
        #expect(pairedMachines(stored: stored, session: nil).map(\.hostKey) == ["mbp", "omarchy"])
    }
}
