import Foundation
import Testing
@testable import PinomadCore

/// The QR sheet's pure parts: the countdown and the loopback rule
/// (devices-dialog.tsx: a 127.0.0.1 link cannot reach another device).
@Suite("Pairing code")
struct PairingCodeTests {
    @Test func remainingSecondsRoundsUpAndStopsAtZero() {
        let now = Date(timeIntervalSince1970: 1)
        #expect(PairingCodeCopy.remainingSeconds(expiresAt: 5_000, now: now) == 4)
        #expect(PairingCodeCopy.remainingSeconds(expiresAt: 1_200, now: now) == 1)
        #expect(PairingCodeCopy.remainingSeconds(expiresAt: 900, now: now) == 0)
        #expect(PairingCodeCopy.remainingSeconds(expiresAt: 1e30, now: now) == 0)
        #expect(PairingCodeCopy.remainingSeconds(expiresAt: -1e30, now: now) == 0)
        #expect(PairingCodeCopy.remainingSeconds(expiresAt: .infinity, now: now) == 0)
    }

    @Test func countdownIsMinutesAndSeconds() {
        #expect(PairingCodeCopy.countdown(5) == "0:05")
        #expect(PairingCodeCopy.countdown(65) == "1:05")
        #expect(PairingCodeCopy.countdown(600) == "10:00")
    }

    @Test func onlyOneTwoSevenIsLoopback() {
        #expect(PairingCodeCopy.isLoopback("ws://127.0.0.1:7420/c/host?pair=x"))
        #expect(PairingCodeCopy.isLoopback("http://127.0.0.1:7420/#pair=x"))
        #expect(!PairingCodeCopy.isLoopback("ws://localhost:7420/c/host?pair=x"))
        #expect(!PairingCodeCopy.isLoopback("wss://relay.example.com/c/host?pair=x"))
        #expect(!PairingCodeCopy.isLoopback("not a url"))
    }
}
