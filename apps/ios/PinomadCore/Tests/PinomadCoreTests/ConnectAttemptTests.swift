import Foundation
import Testing
@testable import PinomadCore

@MainActor
@Suite struct ConnectAttemptTests {
    /// Holds the state the test's apply closure mutates; a mutable local
    /// would escape into the drain's MainActor closure.
    @MainActor
    private final class PairingState {
        var attempt = PairingAttempt()
    }

    @MainActor
    private final class Flag {
        var value = false
    }

    private func host(_ url: String = "ws://127.0.0.1:7422/") -> HostRecord {
        HostRecord(url: url, hostKey: "new-host", privateKey: "new-key")
    }

    /// A handshake response already queued behind the timeout must still be
    /// applied: the link is spent, so Retry has to use the new host record.
    @Test func timeoutDrainsQueuedPairingBeforeFailing() async {
        let (updates, updateSink) = AsyncStream<SessionUpdate>.makeStream()
        let (timeouts, timeoutSink) = AsyncStream<String>.makeStream()
        let pairing = PairingState()
        pairing.attempt.pair(link: "pinomad://pair#pair=old", account: nil, target: nil)
        let newHost = host()

        let attempt = ConnectAttempt(
            updates: updates,
            close: {
                // The core had already emitted .paired when the timeout
                // closed the session; it sits in front of the stream end.
                updateSink.yield(.paired(newHost, saveError: nil))
                updateSink.finish()
            },
            apply: { update in
                if case .paired(let host, _) = update {
                    pairing.attempt.paired(host)
                }
            },
            onTimeout: { address in timeoutSink.yield(address ?? "") }
        )
        attempt.start()
        attempt.timeout(address: "127.0.0.1:7422")

        var iterator = timeouts.makeAsyncIterator()
        #expect(await iterator.next() == "127.0.0.1:7422")
        #expect(pairing.attempt.link == nil)
        #expect(pairing.attempt.retry == .host(newHost))
    }

    /// Ready wins the drain race: the timeout must not replace a live first
    /// view with a failure page.
    @Test func readyDuringDrainSuppressesTheTimeout() async {
        let (updates, updateSink) = AsyncStream<SessionUpdate>.makeStream()
        let (finished, finishedSink) = AsyncStream<Void>.makeStream()
        let timedOut = Flag()

        let attempt = ConnectAttempt(
            updates: updates,
            close: {
                updateSink.yield(.ready(.connected))
                updateSink.finish()
            },
            apply: { _ in },
            onTimeout: { _ in timedOut.value = true },
            onFinished: { finishedSink.yield() }
        )
        attempt.start()
        attempt.timeout(address: "127.0.0.1:7422")

        var iterator = finished.makeAsyncIterator()
        _ = await iterator.next()
        #expect(!timedOut.value)
    }
}
