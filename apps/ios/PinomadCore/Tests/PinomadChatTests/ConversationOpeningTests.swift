import Testing
@testable import PinomadChat

@Suite struct ConversationOpeningTests {
    /// A switch the host refused or the connection dropped settles without
    /// the conversation on screen: its page says so instead of loading forever.
    @Test func failsOnlyWhenTheSwitchSettlesWithoutShowingIt() {
        var opening = ConversationOpening()
        let shown = opening.begin(1)
        opening.settle(1, attempt: shown, shown: 1)
        #expect(opening.failed == nil)

        let refused = opening.begin(2)
        opening.settle(2, attempt: refused, shown: 1)
        #expect(opening.failed == 2)
    }

    /// Back from a child page, the parent reopens; the child's late outcome
    /// must not mark the parent's page.
    @Test func theLatestOpenDecides() {
        var opening = ConversationOpening()
        let child = opening.begin(2)
        let parent = opening.begin(1)
        opening.settle(2, attempt: child, shown: nil)
        #expect(opening.failed == nil)
        opening.settle(1, attempt: parent, shown: 1)
        #expect(opening.failed == nil)
    }

    @Test func retryingGoesBackToLoading() {
        var opening = ConversationOpening()
        opening.settle(3, attempt: opening.begin(3), shown: nil)
        #expect(opening.failed == 3)
        _ = opening.begin(3)
        #expect(opening.failed == nil)
    }
}
