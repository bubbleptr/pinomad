import Testing
@testable import PinomadChat

@Suite struct ReconnectNoticeTests {
    private let start = ContinuousClock.Instant.now

    @Test func aQuickReconnectNeverShows() {
        var notice = ReconnectNotice()
        notice.observe(reconnecting: true, at: start)
        #expect(!notice.isVisible(at: start + .milliseconds(1_400)))

        notice.observe(reconnecting: false, at: start + .milliseconds(1_400))
        #expect(!notice.isVisible(at: start + .seconds(5)))
    }

    @Test func aReconnectThatOutlastsTheGraceShows() {
        var notice = ReconnectNotice()
        notice.observe(reconnecting: true, at: start)
        #expect(notice.isVisible(at: start + ReconnectNotice.grace))
    }

    @Test func moreReconnectingSnapshotsKeepTheFirstStart() {
        // Views keep arriving while the core redials; none of them may push
        // the indicator another grace window out.
        var notice = ReconnectNotice()
        notice.observe(reconnecting: true, at: start)
        notice.observe(reconnecting: true, at: start + .seconds(1))
        #expect(notice.isVisible(at: start + .milliseconds(1_600)))
    }

    @Test func theNextOutageStartsAFreshWindow() {
        var notice = ReconnectNotice()
        notice.observe(reconnecting: true, at: start)
        notice.observe(reconnecting: false, at: start + .seconds(5))
        notice.observe(reconnecting: true, at: start + .seconds(6))
        #expect(!notice.isVisible(at: start + .seconds(7)))
    }

    @Test func returningToTheForegroundRestartsTheWindow() {
        // A socket that died while suspended went reconnecting before the
        // app came back; the redial on return gets its own grace.
        var notice = ReconnectNotice()
        notice.observe(reconnecting: true, at: start)
        notice.restart(at: start + .seconds(60))
        #expect(!notice.isVisible(at: start + .seconds(61)))
        #expect(notice.isVisible(at: start + .seconds(62)))
    }
}
