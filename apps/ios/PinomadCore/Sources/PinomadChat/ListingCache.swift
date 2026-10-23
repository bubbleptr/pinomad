import Foundation
import PinomadCore

/// A per-key listing cache: `listSkills` per scope behind the `$` menu,
/// composer highlight and sent bubbles (issue #143), and `listCommands` per
/// conversation behind the `/` menu (#254). It is the same shape as the Web
/// cache: one entry per key, concurrent asks share one flight, an answer is
/// trusted for a few seconds, a failure is never cached, and the last good
/// answer stays visible while a refresh is in flight.
///
/// Plain value state with an injected clock: the app owns the request and
/// hands answers back, so the rules stay deterministic to test.
public struct ListingCache<Key: Hashable & Sendable, Item: Equatable & Sendable>: Equatable, Sendable {
    /// How long an answer is trusted before the next ask refetches it.
    public static var defaultTTL: TimeInterval { 5 }

    /// One flight the caller should run. The generation makes late answers
    /// from an older request (or an older host session) harmless.
    public struct Request: Equatable, Sendable {
        public let key: Key
        public let generation: UInt64

        public init(key: Key, generation: UInt64) {
            self.key = key
            self.generation = generation
        }
    }

    private struct Entry: Equatable {
        /// Nil until the first successful answer. An empty array is a known
        /// empty listing.
        var items: [Item]?
        var at: TimeInterval = 0
        var inflight: UInt64?
    }

    private let ttl: TimeInterval
    private var entries: [Key: Entry] = [:]
    private var generation: UInt64 = 0

    public init(ttl: TimeInterval = ListingCache.defaultTTL) {
        self.ttl = ttl
    }

    /// The key's last good listing, or nil while it is unknown.
    public func snapshot(_ key: Key) -> [Item]? {
        entries[key]?.items
    }

    /// Returns the key to fetch, or nil when an in-flight request already
    /// covers it or the current answer is still fresh. `force` bypasses the
    /// TTL (the refresh a reconnect performs) but never starts a second
    /// flight for the same key.
    public mutating func request(
        _ key: Key,
        now: TimeInterval,
        force: Bool = false
    ) -> Request? {
        if let entry = entries[key] {
            if entry.inflight != nil { return nil }
            if !force, entry.items != nil, now - entry.at < ttl { return nil }
        }
        generation &+= 1
        var entry = entries[key] ?? Entry()
        entry.inflight = generation
        entries[key] = entry
        return Request(key: key, generation: generation)
    }

    /// A successful answer. A late answer from a superseded request (a
    /// failure/retry, a scope switch, a host session that reset the cache)
    /// is dropped.
    public mutating func receive(_ request: Request, items: [Item], now: TimeInterval) {
        guard entries[request.key]?.inflight == request.generation else { return }
        entries[request.key] = Entry(items: items, at: now, inflight: nil)
    }

    /// A failed request is not an answer: keep whatever was known, clear the
    /// flight so the next ask retries.
    public mutating func fail(_ request: Request) {
        guard var entry = entries[request.key],
              entry.inflight == request.generation else { return }
        entry.inflight = nil
        entries[request.key] = entry
    }

    /// A new host identity never inherits the previous host's listings; a
    /// late answer from the old session is ignored by generation.
    public mutating func reset() {
        generation &+= 1
        entries.removeAll()
    }
}

public typealias SkillListCache = ListingCache<SkillScope, SkillEntry>
public typealias CommandListCache = ListingCache<UInt64, CommandEntry>
