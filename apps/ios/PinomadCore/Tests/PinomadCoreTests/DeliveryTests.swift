import Foundation
import os
import Testing
@testable import PinomadCore

private func fakeSnapshot(version: UInt64) -> ClientSnapshot {
    ClientSnapshot(
        version: version,
        connection: .connected,
        unauthorized: false,
        protocolMismatch: nil,
        host: nil,
        hostName: nil,
        settings: nil,
        devices: [],
        organized: Organized(chats: [], projects: [], archived: []),
        notices: [],
        models: [],
        defaults: Defaults(model: nil, thinkingLevel: nil),
        agents: nil,
        conversation: nil
    )
}

/// `ViewChanged` coalescing: at most one `snapshot()` in flight; a dirty
/// mark during a compute schedules exactly one follow-up. A semaphore in
/// the injected snapshotter makes "during the compute" deterministic.
@Suite("Snapshot delivery")
struct SnapshotDeliveryTests {
    @Test func burstCoalescesToOneComputePerRound() async throws {
        let gate = DispatchSemaphore(value: 0)
        let computes = OSAllocatedUnfairLock<UInt64>(initialState: 0)
        let (session, _, _, _) = try makeSession(configure: { deps in
            deps.snapshotter = {
                let n = computes.withLock { v -> UInt64 in
                    v += 1
                    return v
                }
                gate.wait()
                return fakeSnapshot(version: n)
            }
        })
        let reader = UpdateReader(session)
        await session.waitForIdle()

        session.enqueue(.commands([FfiCommand.viewChanged]))
        // waitForIdle only covers the queue — the snapshot Task itself
        // still has to be scheduled. Spin until it actually starts.
        await spinUntil({ computes.withLock { $0 } == 1 }, "first compute starts")
        // The first compute blocks at the gate; more ViewChanged just set
        // the dirty flag — no second compute may start.
        session.enqueue(.commands([FfiCommand.viewChanged, FfiCommand.viewChanged]))
        await session.waitForIdle()
        #expect(computes.withLock { $0 } == 1)

        gate.signal() // compute #1 (v1) finishes
        await session.waitForIdle()
        guard case .snapshot(let first) = await reader.next(timeout: .seconds(5)) else {
            Issue.record("expected a published snapshot")
            return
        }
        #expect(first.version == 1)

        // The dirty flag triggered exactly one follow-up.
        gate.signal() // compute #2 (v2)
        await spinUntil({ computes.withLock { $0 } == 2 }, "follow-up compute starts")
        gate.signal()
        await session.waitForIdle()
        guard case .snapshot(let second) = await reader.next(timeout: .seconds(5)) else {
            Issue.record("expected the follow-up snapshot")
            return
        }
        #expect(second.version == 2)
        #expect(computes.withLock { $0 } == 2)
        session.close()
    }

    @Test func staleVersionsAreDropped() async throws {
        let versions = OSAllocatedUnfairLock(initialState: [UInt64(10), 5])
        let (session, _, _, _) = try makeSession(configure: { deps in
            deps.snapshotter = {
                fakeSnapshot(version: versions.withLock { $0.removeFirst() })
            }
        })
        let reader = UpdateReader(session)
        await session.waitForIdle()

        session.enqueue(.commands([FfiCommand.viewChanged]))
        await session.waitForIdle()
        guard case .snapshot(let first) = await reader.next(timeout: .seconds(5)) else {
            Issue.record("expected a snapshot")
            return
        }
        #expect(first.version == 10)
        #expect(session.lastPublishedVersion == 10)

        // A snapshot computed behind a newer one never publishes.
        session.enqueue(.commands([FfiCommand.viewChanged]))
        await spinUntil({ versions.withLock { $0.isEmpty } }, "stale compute ran")
        await session.waitForIdle()
        #expect(session.lastPublishedVersion == 10)
        session.close()
    }
}

/// `Paired` persistence through the real dispatch path. The app hears of
/// every pairing the moment the handshake stores it — the one-time code is
/// spent then, before (and whether or not) the first view arrives — and
/// store failures ride along instead of being swallowed.
@Suite("Host store")
struct HostStoreTests {
    @Test func pairedPersistsAndMarksActive() async throws {
        let (session, _, _, store) = try makeSession()
        let reader = UpdateReader(session)
        await session.waitForIdle()

        session.enqueue(.commands([.paired(
            url: "ws://192.168.1.2:7420/",
            hostKey: String(repeating: "B", count: 43),
            privateKey: String(repeating: "C", count: 43)
        )]))
        await session.waitForIdle()

        #expect(store.stored.active?.hostKey == String(repeating: "B", count: 43))
        #expect(store.stored.hosts.count == 1)
        guard case .paired(let host, nil) = await reader.next(timeout: .seconds(5)) else {
            Issue.record("expected paired with no save error")
            return
        }
        #expect(host.hostKey == String(repeating: "B", count: 43))
        session.close()
    }

    @Test func storeSaveFailureRidesOnPaired() async throws {
        let (session, _, _, store) = try makeSession()
        let reader = UpdateReader(session)
        store.saveError = FakeError.storeBroken
        await session.waitForIdle()

        session.enqueue(.commands([.paired(
            url: "ws://10.0.0.1:7420/",
            hostKey: String(repeating: "D", count: 43),
            privateKey: String(repeating: "E", count: 43)
        )]))
        await session.waitForIdle()

        guard case .paired(_, .some) = await reader.next(timeout: .seconds(5)) else {
            Issue.record("expected paired with a save error for the failed save")
            return
        }
        session.close()
    }

    @Test func storeLoadFailureRidesOnPaired() async throws {
        let (session, _, _, store) = try makeSession()
        let reader = UpdateReader(session)
        store.loadError = FakeError.storeBroken
        await session.waitForIdle()

        session.enqueue(.commands([.paired(
            url: "ws://10.0.0.1:7420/",
            hostKey: String(repeating: "F", count: 43),
            privateKey: String(repeating: "F", count: 43)
        )]))
        await session.waitForIdle()

        guard case .paired(_, .some) = await reader.next(timeout: .seconds(5)) else {
            Issue.record("expected paired with a save error for the failed load")
            return
        }
        session.close()
    }

    // The bare SwiftPM test runner has no keychain entitlement
    // (SecItem* → -34018), so `KeychainHostStore` itself is exercised
    // end-to-end in the real app instead — the store contract is covered
    // here through the injectable protocol.
}
