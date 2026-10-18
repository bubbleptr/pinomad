import Testing
@testable import PinomadChat
import PinomadCore

private func listing(_ path: String) -> FolderListing {
    FolderListing(path: path, home: "/home/me", folders: [])
}

@Suite struct FolderBrowserTests {
    /// Tapping through folders quickly: a slower answer for an earlier
    /// folder must not replace the folder the reader is now in.
    @Test func onlyTheNewestNavigationLands() {
        var browser = FolderBrowser()
        let first = browser.go(to: "/home/me/a")
        let second = browser.go(to: "/home/me/b")
        browser.land(second, listing("/home/me/b"))
        browser.land(first, listing("/home/me/a"))
        #expect(browser.listing?.path == "/home/me/b")
        #expect(!browser.loading)
    }

    @Test func aStaleFailureIsIgnored() {
        var browser = FolderBrowser()
        let first = browser.go(to: "/x")
        let second = browser.go(to: "/y")
        browser.fail(first, "Permission denied")
        #expect(browser.error == nil)
        #expect(browser.loading)
        browser.land(second, listing("/y"))
        #expect(browser.listing?.path == "/y")
    }

    /// A failed browse keeps the last good listing (so the crumbs stay
    /// usable) and remembers which folder to ask again.
    @Test func failureKeepsTheListingAndTheRetryPath() {
        var browser = FolderBrowser()
        browser.land(browser.go(to: nil), listing("/home/me"))
        let token = browser.go(to: "/root")
        browser.fail(token, "Permission denied")
        #expect(browser.listing?.path == "/home/me")
        #expect(browser.error == "Permission denied")
        #expect(browser.retryPath == "/root")
        #expect(!browser.loading)
    }
}
