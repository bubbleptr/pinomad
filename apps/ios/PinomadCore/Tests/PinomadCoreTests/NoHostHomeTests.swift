import Testing
@testable import PinomadCore

/// What an iPhone with no stored host opens on (#493): today's connect page,
/// or the add-your-first-host home for an account with no hosts at all.
@Suite("No-host home")
struct NoHostHomeTests {
    private func row(_ id: String, online: Bool, pairing: AccountHostPairing) -> AccountHostRow {
        AccountHostRow(
            hostId: id, name: id, online: online, pairing: pairing,
            status: .unpaired, action: .pair, storedHostKey: nil)
    }

    /// Signed out, home stays the sign-in entry and asks the server nothing.
    @Test func signedOutKeepsTheConnectPage() {
        let home = NoHostHome(signedIn: false, accountHosts: nil, hostsError: nil)
        #expect(home.screen == .connect)
        #expect(!home.refreshesAccountHosts)
    }

    /// Before the first answer the account may well have hosts: no join
    /// command is minted for it, but the page keeps asking.
    @Test func signedInBeforeTheFirstAnswerKeepsTheConnectPage() {
        let home = NoHostHome(signedIn: true, accountHosts: nil, hostsError: nil)
        #expect(home.screen == .connect)
        #expect(home.refreshesAccountHosts)
    }

    @Test func signedInWithNoAccountHostsShowsFirstHost() {
        let home = NoHostHome(signedIn: true, accountHosts: [], hostsError: nil)
        #expect(home.screen == .firstHost(refreshError: nil))
        #expect(home.refreshesAccountHosts)
    }

    /// A host that joined offline is listed and swaps the first-host home
    /// for the connect page, where it can be paired. The refresh keeps
    /// running so the round after it comes online pairs it on its own; it
    /// stops only when a stored host takes the app off this page.
    @Test func anOfflineHostKeepsTheConnectPageAndTheRefresh() {
        let home = NoHostHome(
            signedIn: true,
            accountHosts: [row("mbp", online: false, pairing: .offline)],
            hostsError: nil)
        #expect(home.screen == .connect)
        #expect(home.refreshesAccountHosts)
    }

    /// A failed refresh keeps the last (empty) list: the home stays and
    /// says so, instead of flipping on every network blip.
    @Test func aFailedRefreshKeepsFirstHostWithAWarning() {
        let home = NoHostHome(
            signedIn: true, accountHosts: [], hostsError: "Can't reach the server.")
        #expect(home.screen == .firstHost(refreshError: "Can't reach the server."))
        #expect(home.refreshesAccountHosts)
    }
}
