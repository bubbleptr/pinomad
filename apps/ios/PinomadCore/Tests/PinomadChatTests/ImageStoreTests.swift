import Foundation
import Testing
@testable import PinomadChat

private enum TestFailure: Error {
    case boom
}

/// One shared request gate. Every loader call announces itself, then waits
/// until the test opens the gate — no sleeps, so the concurrency assertions
/// are deterministic.
private actor LoadGate {
    private var open = false
    private(set) var started = 0
    private(set) var active = 0
    private(set) var maximum = 0
    private var startWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func begin() async {
        started += 1
        active += 1
        maximum = max(maximum, active)
        let ready = startWaiters.filter { $0.0 <= started }
        startWaiters.removeAll { $0.0 <= started }
        for (_, waiter) in ready { waiter.resume() }
        if !open {
            await withCheckedContinuation { releaseWaiters.append($0) }
        }
        active -= 1
    }

    func waitForStarted(_ count: Int) async {
        guard started < count else { return }
        await withCheckedContinuation { startWaiters.append((count, $0)) }
    }

    func openGate() {
        open = true
        let waiting = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiting { waiter.resume() }
    }
}

private actor FlakyLoader {
    private(set) var calls = 0

    func load(_ image: CachedImage) throws -> CachedImage {
        calls += 1
        if calls == 1 { throw TestFailure.boom }
        return image
    }
}

private func image(bytes: Int, seed: UInt8 = 0) -> CachedImage {
    CachedImage(
        data: Data((0..<bytes).map { seed &+ UInt8($0 % 251) }).base64EncodedString(),
        mimeType: "image/png"
    )
}

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("pinomad-image-store-\(UUID().uuidString)")
}

@Suite struct ImageStoreTests {
    @Test func concurrentLoadsForTheSameRefShareOneRequest() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ImageStore(directory: directory, limits: .init(memoryBytes: 0, diskBytes: 1_000_000, maxInFlight: 4))
        let gate = LoadGate()
        let image = image(bytes: 32)

        let first = Task {
            try await store.load(ref: "same-ref") { _ in
                await gate.begin()
                return image
            }
        }
        let second = Task {
            try await store.load(ref: "same-ref") { _ in
                await gate.begin()
                return image
            }
        }
        await gate.waitForStarted(1)
        while await store.debugLoadAttempts < 2 { await Task.yield() }
        await gate.openGate()

        let one = try await first.value
        let two = try await second.value
        #expect(one == two)
        #expect(await gate.started == 1)
    }

    @Test func atMostFourRequestsAreInFlight() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ImageStore(directory: directory, limits: .init(memoryBytes: 0, diskBytes: 1_000_000, maxInFlight: 4))
        let gate = LoadGate()
        let image = image(bytes: 16)

        let tasks = (0..<6).map { index in
            Task {
                try await store.load(ref: "ref-\(index)") { _ in
                    await gate.begin()
                    return image
                }
            }
        }
        await gate.waitForStarted(4)
        await gate.openGate()
        for task in tasks { _ = try await task.value }
        #expect(await gate.maximum == 4)
        #expect(await gate.started == 6)
    }

    /// The newest write survives; the least-recently-used file goes first.
    /// Reading a ref touches it, so the middle entry survives the next
    /// insertion instead of the oldest-by-write-time one.
    @Test func diskCapEvictsTheLeastRecentlyUsedFile() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ImageStore(directory: directory, limits: .init(memoryBytes: 0, diskBytes: 1_200, maxInFlight: 4))

        let first = try #require(await store.prefill(image(bytes: 500, seed: 1)))
        let second = try #require(await store.prefill(image(bytes: 500, seed: 2)))
        let third = try #require(await store.prefill(image(bytes: 500, seed: 3)))
        #expect(await store.debugDiskBytes <= 1_200)
        #expect(await store.cached(ref: first) == nil)
        #expect(await store.cached(ref: second) != nil)
        #expect(await store.cached(ref: third) != nil)

        // Touch the middle entry, then insert a fourth: the just-touched
        // entry must outlive the third.
        _ = await store.cached(ref: second)
        let fourth = try #require(await store.prefill(image(bytes: 500, seed: 4)))
        #expect(await store.cached(ref: second) != nil)
        #expect(await store.cached(ref: third) == nil)
        #expect(await store.cached(ref: fourth) != nil)
        #expect(await store.debugDiskBytes <= 1_200)
    }

    /// A failed fetch is not a cached absence: the next call asks again.
    @Test func failureIsRetriedInsteadOfCached() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ImageStore(directory: directory, limits: .init(memoryBytes: 1024, diskBytes: 1_000_000, maxInFlight: 4))
        let loader = FlakyLoader()
        let image = image(bytes: 24)

        do {
            _ = try await store.load(ref: "retry-me") { _ in try await loader.load(image) }
            Issue.record("the first load must fail")
        } catch TestFailure.boom {
            // expected
        }

        let loaded = try await store.load(ref: "retry-me") { _ in try await loader.load(image) }
        #expect(loaded == image)
        #expect(await loader.calls == 2)
    }

    /// The disk tier is what makes a relaunch free: a new store over the
    /// same directory finds the ref without asking the host.
    @Test func diskCacheSurvivesANewStoreInstance() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let image = image(bytes: 40, seed: 5)
        let first = ImageStore(directory: directory, limits: .init(memoryBytes: 0, diskBytes: 1_000_000, maxInFlight: 4))
        let ref = try #require(await first.prefill(image))

        let second = ImageStore(directory: directory, limits: .init(memoryBytes: 0, diskBytes: 1_000_000, maxInFlight: 4))
        let loaded = try await second.load(ref: ref) { _ in
            Issue.record("a relaunch must read the disk tier")
            throw TestFailure.boom
        }
        #expect(loaded == image)
    }

    /// A locally prepared image is already warm: opening or reconnecting
    /// does not download its own attachment back.
    @Test func prefillServesTheNextLoad() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ImageStore(directory: directory, limits: .init(memoryBytes: 4096, diskBytes: 1_000_000, maxInFlight: 4))
        let image = image(bytes: 12, seed: 9)
        let ref = try #require(await store.prefill(image))

        let loaded = try await store.load(ref: ref) { _ in
            Issue.record("prefilled bytes must not hit the host")
            throw TestFailure.boom
        }
        #expect(loaded == image)
    }
}
