import Foundation
import Testing
@testable import PinomadCore

/// The generated bindings exercised for real — construction, take,
/// handle, snapshot, free functions — including non-BMP text, since
/// strings cross as UTF-16 (ADR-0024 §4).
@Suite("Generated bindings")
struct BindingTests {
    @Test func pairTakeAndHandle() throws {
        let client = try PinomadClient.pair(
            link: testPairingLink, deviceName: "测试 iPhone 📱", devicePrivateKey: nil)

        let initial = client.take()
        guard case .openConnection(let conn, let url) = initial.first else {
            Issue.record("take() should start with OpenConnection, got \(initial)")
            return
        }
        #expect(conn == 1)
        #expect(url == "ws://127.0.0.1:9999/")
        #expect(client.snapshot() == nil)

        // Opening the socket starts the Noise handshake: bytes out.
        let opened = client.handle(event: .socketOpened(conn: 1))
        #expect(opened.contains {
            if case .sendBytes(let c, _) = $0 { return c == 1 }
            return false
        })
    }

    @Test func eventsForUnknownConnAreDropped() throws {
        let client = try PinomadClient.pair(
            link: testPairingLink, deviceName: "t", devicePrivateKey: nil)
        _ = client.take()
        // A conn id that was never opened produces nothing.
        #expect(client.handle(event: .socketData(conn: 99, bytes: Data([1, 2, 3]))).isEmpty)
        #expect(client.handle(event: .socketClosed(conn: 99, code: 1006, reason: nil)).isEmpty)
        #expect(client.handle(event: .sendFailed(conn: 99)).isEmpty)
        #expect(client.handle(event: .timerFired(timer: 42)).isEmpty)
    }

    @Test func invokeWhileDisconnectedFailsFast() throws {
        let client = try PinomadClient.pair(
            link: testPairingLink, deviceName: "t", devicePrivateKey: nil)
        _ = client.take()
        // Request-class ops reject with OperationFailed when not connected.
        let commands = client.handle(event: .invoke(
            op: 7, call: .renameConversation(id: 1, title: "改名 🍂")))
        guard case .operationFailed(let op, let error) = commands.last else {
            Issue.record("expected OperationFailed, got \(commands)")
            return
        }
        #expect(op == 7)
        #expect(!error.isEmpty)
    }

    @Test func unicodeSurvivesTheBoundary() throws {
        // Chinese + emoji round-trip through free functions that decode
        // the typed record back into the core's UTF-16 JSON.
        let summary = ConversationSummary(
            id: 12, kind: nil, parent: nil, forkedAt: nil,
            title: "秋天随笔 🍂📖", status: nil, updatedAt: nil,
            label: nil, role: nil, activity: nil)
        #expect(displayName(summary: summary) == "秋天随笔 🍂📖")

        let hostKey = String(repeating: "A", count: 43) // 32 zero bytes
        let host = StoredHost(
            url: "ws://192.168.1.2:7420/",
            hostKey: hostKey, privateKey: hostKey, account: nil)
        #expect(try validateStoredHost(host: host) == host)
    }

    @Test func validateStoredHostRejectsBadRecords() throws {
        let key = String(repeating: "A", count: 43)
        func host(url: String, hostKey: String = "", privateKey: String = "") -> StoredHost {
            StoredHost(url: url, hostKey: hostKey, privateKey: privateKey, account: nil)
        }
        #expect(throws: StoredHostError.self) {
            try validateStoredHost(host: host(url: "https://example.com"))
        }
        #expect(throws: StoredHostError.self) {
            try validateStoredHost(host: host(url: "ws://h:1/", hostKey: "not-a-key", privateKey: key))
        }
        #expect(throws: StoredHostError.self) {
            try validateStoredHost(host: host(url: "ws://h:1/", hostKey: key, privateKey: "AQ=="))
        }
    }

    @Test func invalidPairingLinkThrows() {
        #expect(throws: (any Error).self) {
            _ = try PinomadClient.pair(link: "not a link", deviceName: "t", devicePrivateKey: nil)
        }
        #expect(throws: (any Error).self) {
            _ = try PinomadClient.pair(
                link: "https://example.com/#pair=bad.bad", deviceName: "t", devicePrivateKey: nil)
        }
    }
}
