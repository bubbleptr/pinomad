import Foundation
import Testing
@testable import PinomadCore

/// Confirming a host join by its short code (#497): the code field, the
/// lookup → review → confirm/deny flow, and what each server answer says.
@Suite("Host link")
struct HostLinkTests {
    private let request = HostLinkRequest(
        hostId: "Kx3f9Q2aZ8mN1pLr5tVw7yB0cD4eF6gH8iJ0kL2mN4o",
        name: "studio",
        os: "macOS 26.1",
        sourceIp: "203.0.113.7",
        ipDiffers: false,
        expiresAt: 600_000)

    // MARK: - The code field

    /// What a person types — lowercase, spaces, the dash in any place —
    /// shows as the host prints it.
    @Test func typedCodeShowsAsTheHostPrintsIt() {
        #expect(HostLinkCode.format("kxhn bwcv") == "KXHN-BWCV")
        #expect(HostLinkCode.format("KX-HNBW-CV") == "KXHN-BWCV")
        #expect(HostLinkCode.format("kxh") == "KXH")
        #expect(HostLinkCode.format("kxhn") == "KXHN")
        #expect(HostLinkCode.format("kxhnb") == "KXHN-B")
        #expect(HostLinkCode.format("") == "")
    }

    /// A pasted line with more than a code stops at eight letters, and
    /// anything that isn't a letter never shows.
    @Test func formattingStopsAtEightLetters() {
        #expect(HostLinkCode.format("KXHN-BWCV-ZZ") == "KXHN-BWCV")
        #expect(HostLinkCode.format("KX1HN") == "KXHN")
    }

    /// Only a complete code from the server's alphabet is sent: the server
    /// counts a malformed one against the account's and the address's
    /// lockout, so a typo must stop here.
    @Test func onlyACompleteCodeFromTheAlphabetIsSent() {
        #expect(HostLinkCode.normalize("kxhn-bwcv") == "KXHNBWCV")
        #expect(HostLinkCode.normalize(" KXHN BWCV ") == "KXHNBWCV")
        #expect(HostLinkCode.normalize("KXHN-BWC") == nil)
        // Vowels and Y are left out of the alphabet: never a real code.
        #expect(HostLinkCode.normalize("KXHN-BWCA") == nil)
        #expect(HostLinkCode.normalize("KXHN-BWCY") == nil)
        #expect(HostLinkCode.normalize("KXHN-BWCV1") == nil)
    }

    // MARK: - The command

    /// The install script (#499) runs `pinomad up` (#498) itself, which
    /// asks for a code; the server is always named, so a host joined
    /// elsewhere is refused instead of kept there.
    @Test func tokenlessCommandHasTheScriptRunUpNamingTheServer() {
        #expect(HostLinkCopy.joinCommand(serverOrigin: "https://accounts.example.com/")
            == "curl -fsSL https://pinomad.si/install.sh | sh -s -- up --origin https://accounts.example.com")
        #expect(HostLinkCopy.joinCommand(serverOrigin: OfficialServer.origin)
            == "curl -fsSL https://pinomad.si/install.sh | sh -s -- up --origin https://app.pinomad.si")
    }

    // MARK: - The host id

    /// The host prints its full id; the confirm page shows both ends of it
    /// to compare, and copies all of it.
    @Test func hostIdShowsBothEnds() {
        #expect(HostLinkCopy.shortHostId(request.hostId) == "Kx3f9Q…mN4o")
        #expect(HostLinkCopy.shortHostId("short") == "short")
    }

    // MARK: - Errors

    /// The server answers one 404 for a wrong, used and expired code alike:
    /// at lookup that means check the code, at confirm that it died while
    /// the page was open. Neither falls through to the generic message.
    @Test func eachFailureHasItsOwnMessage() {
        let notFound = AccountFailure(code: "not_found", status: 404)
        let atLookup = HostLinkCopy.message(notFound, stage: .lookup)
        let atConfirm = HostLinkCopy.message(notFound, stage: .confirm)
        #expect(atLookup != atConfirm)
        #expect(atLookup != AccountCopy.message(notFound))
        #expect(atConfirm != AccountCopy.message(notFound))
        // Locked out of guessing, not of signing in.
        let limited = AccountFailure(code: "rate_limited", status: 429)
        #expect(HostLinkCopy.message(limited, stage: .lookup) != AccountCopy.message(limited))
        // Everything else reads as on every other account call.
        #expect(HostLinkCopy.message(.network, stage: .confirm) == AccountCopy.message(.network))
        let signedOut = AccountFailure(code: "unauthenticated", status: 401)
        #expect(HostLinkCopy.message(signedOut, stage: .lookup) == AccountCopy.message(signedOut))
    }

    // MARK: - Flow

    @Test func lookupNeedsACompleteCode() {
        var flow = HostLinkFlow()
        flow.type("kxhn-bwc")
        #expect(!flow.canLookUp)
        #expect(flow.beginLookup() == nil)
        #expect(flow.step == .entering)

        flow.type("kxhn-bwcv")
        #expect(flow.input == "KXHN-BWCV")
        #expect(flow.canLookUp)
        #expect(flow.beginLookup() == "KXHNBWCV")
        #expect(flow.step == .lookingUp(code: "KXHNBWCV"))
        // A second tap while waiting sends nothing more.
        #expect(flow.beginLookup() == nil)
    }

    @Test func aFoundHostIsReviewedThenConfirmed() {
        var flow = HostLinkFlow()
        flow.type("KXHNBWCV")
        _ = flow.beginLookup()
        flow.lookupFinished(code: "KXHNBWCV", .success(request))
        #expect(flow.step == .reviewing(code: "KXHNBWCV", request: request))
        #expect(flow.error == nil)

        let now = Date(timeIntervalSince1970: 1)
        #expect(flow.canConfirm(now: now))
        #expect(flow.beginConfirm(now: now) == "KXHNBWCV")
        #expect(flow.step == .confirming(code: "KXHNBWCV", request: request))
        #expect(flow.beginDeny() == nil)

        flow.confirmFinished(code: "KXHNBWCV", .success(()))
        #expect(flow.step == .joined(request))
    }

    @Test func aDeniedHostEndsDenied() {
        var flow = reviewing()
        #expect(flow.beginDeny() == "KXHNBWCV")
        #expect(flow.step == .denying(code: "KXHNBWCV", request: request))
        flow.denyFinished(code: "KXHNBWCV", .success(()))
        #expect(flow.step == .denied(request))
    }

    /// A wrong code goes back to the field, with the code kept to correct.
    @Test func aFailedLookupGoesBackToTheField() {
        var flow = HostLinkFlow()
        flow.type("KXHNBWCV")
        _ = flow.beginLookup()
        flow.lookupFinished(code: "KXHNBWCV", .failure(AccountFailure(code: "not_found", status: 404)))
        #expect(flow.step == .entering)
        #expect(flow.input == "KXHN-BWCV")
        #expect(flow.error == HostLinkCopy.message(AccountFailure(code: "not_found"), stage: .lookup))
        // Editing the code clears the message.
        flow.type("KXHN-BWCW")
        #expect(flow.error == nil)
    }

    /// Past its expiry the page can't confirm: the server would refuse.
    @Test func anExpiredRequestCantBeConfirmed() {
        var flow = reviewing()
        let late = Date(timeIntervalSince1970: 601)
        #expect(!flow.canConfirm(now: late))
        #expect(flow.beginConfirm(now: late) == nil)
        // Deny still works: it only tidies up on the server.
        #expect(flow.beginDeny() == "KXHNBWCV")
    }

    /// A code that died while the page was open sends the reader back for a
    /// new one; a dropped connection keeps the page to try again.
    @Test func aFailedConfirmKeepsOrLeavesThePage() {
        var dead = reviewing()
        _ = dead.beginConfirm(now: Date(timeIntervalSince1970: 1))
        dead.confirmFinished(code: "KXHNBWCV", .failure(AccountFailure(code: "not_found", status: 404)))
        #expect(dead.step == .entering)
        #expect(dead.error == HostLinkCopy.message(AccountFailure(code: "not_found"), stage: .confirm))

        var offline = reviewing()
        _ = offline.beginConfirm(now: Date(timeIntervalSince1970: 1))
        offline.confirmFinished(code: "KXHNBWCV", .failure(.network))
        #expect(offline.step == .reviewing(code: "KXHNBWCV", request: request))
        #expect(offline.error == AccountCopy.message(.network))
    }

    /// An answer for a request the reader already walked away from changes
    /// nothing.
    @Test func aLateAnswerIsDropped() {
        var flow = HostLinkFlow()
        flow.type("KXHNBWCV")
        _ = flow.beginLookup()
        flow.startOver()
        flow.lookupFinished(code: "KXHNBWCV", .success(request))
        #expect(flow.step == .entering)
        #expect(flow.input == "")

        var confirmed = reviewing()
        _ = confirmed.beginConfirm(now: Date(timeIntervalSince1970: 1))
        confirmed.lookupFinished(code: "KXHNBWCV", .failure(.network))
        #expect(confirmed.step == .confirming(code: "KXHNBWCV", request: request))
    }

    private func reviewing() -> HostLinkFlow {
        var flow = HostLinkFlow()
        flow.type("KXHNBWCV")
        _ = flow.beginLookup()
        flow.lookupFinished(code: "KXHNBWCV", .success(request))
        return flow
    }
}
