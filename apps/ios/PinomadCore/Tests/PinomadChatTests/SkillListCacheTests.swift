import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func listed(_ name: String) -> SkillEntry {
    SkillEntry(name: name, description: "", source: .user)
}

/// #require can't wrap a mutating call (the macro takes it as an immutable
/// autoclosure); evaluate the request first.
private func required(_ request: SkillListCache.Request?) throws -> SkillListCache.Request {
    try #require(request)
}

@Suite struct SkillListCacheTests {
    private let conversation = SkillScope.conversation(conversationId: 7)
    private let other = SkillScope.conversation(conversationId: 8)

    @Test func nothingIsKnownUntilTheFirstAnswer() throws {
        var cache = SkillListCache()
        #expect(cache.snapshot(conversation) == nil)
        let request = try required(cache.request(conversation, now: 100))
        #expect(cache.snapshot(conversation) == nil)
        cache.receive(request, items: [listed("review")], now: 101)
        #expect(cache.snapshot(conversation)?.map(\.name) == ["review"])
    }

    @Test func concurrentRequestsShareOneFlight() throws {
        var cache = SkillListCache()
        let first = try required(cache.request(conversation, now: 100))
        #expect(cache.request(conversation, now: 100) == nil)
        cache.receive(first, items: [listed("review")], now: 101)
        #expect(cache.request(conversation, now: 102) == nil)
    }

    @Test func aFreshAnswerSurvivesTheTTL() throws {
        var cache = SkillListCache(ttl: 5)
        let first = try required(cache.request(conversation, now: 100))
        cache.receive(first, items: [listed("review")], now: 100)
        #expect(cache.request(conversation, now: 104.9) == nil)
        let second = try required(cache.request(conversation, now: 105))
        #expect(second.key == conversation)
    }

    @Test func forceRefreshesAnOtherwiseFreshEntry() throws {
        var cache = SkillListCache()
        let first = try required(cache.request(conversation, now: 100))
        cache.receive(first, items: [listed("review")], now: 100)
        #expect(cache.request(conversation, now: 101, force: true) != nil)
    }

    @Test func aFailureIsNotCachedAndRetriesAtOnce() throws {
        var cache = SkillListCache()
        let first = try required(cache.request(conversation, now: 100))
        cache.fail(first)
        #expect(cache.snapshot(conversation) == nil)
        #expect(cache.request(conversation, now: 100) != nil)
    }

    @Test func aFailureKeepsTheLastGoodAnswer() throws {
        var cache = SkillListCache()
        let first = try required(cache.request(conversation, now: 100))
        cache.receive(first, items: [listed("review")], now: 100)
        let refresh = try required(cache.request(conversation, now: 106))
        cache.fail(refresh)
        #expect(cache.snapshot(conversation)?.map(\.name) == ["review"])
        // The failed refresh still doesn't extend the TTL, but the next
        // request is allowed because no flight is left.
        #expect(cache.request(conversation, now: 106) != nil)
    }

    @Test func scopesAreIsolated() throws {
        var cache = SkillListCache()
        let seven = try required(cache.request(conversation, now: 100))
        cache.receive(seven, items: [listed("review")], now: 100)
        #expect(cache.snapshot(other) == nil)
        let eight = try required(cache.request(other, now: 100))
        cache.receive(eight, items: [listed("deploy")], now: 100)
        #expect(cache.snapshot(conversation)?.map(\.name) == ["review"])
        #expect(cache.snapshot(other)?.map(\.name) == ["deploy"])
    }

    @Test func resetDropsLateAnswers() throws {
        var cache = SkillListCache()
        let first = try required(cache.request(conversation, now: 100))
        cache.reset()
        #expect(cache.snapshot(conversation) == nil)
        cache.receive(first, items: [listed("old")], now: 101)
        #expect(cache.snapshot(conversation) == nil)
    }

    @Test func aStaleAnswerAfterANewRequestIsIgnored() throws {
        var cache = SkillListCache()
        let first = try required(cache.request(conversation, now: 100))
        cache.fail(first)
        let second = try required(cache.request(conversation, now: 100))
        cache.receive(first, items: [listed("stale")], now: 101)
        #expect(cache.snapshot(conversation) == nil)
        cache.receive(second, items: [listed("fresh")], now: 101)
        #expect(cache.snapshot(conversation)?.map(\.name) == ["fresh"])
    }
}
