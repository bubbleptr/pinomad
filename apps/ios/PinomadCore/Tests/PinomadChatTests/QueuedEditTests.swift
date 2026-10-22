import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private let copy = QueuedEdit.Copy(
    conversationId: 7,
    id: 42,
    text: "recover me",
    images: [MessageImage(data: "AAAA", mimeType: "image/jpeg")]
)

@Suite struct QueuedEditTests {
    @Test func withdrawnHandsBackTheCopyAndUnlocks() {
        var edit = QueuedEdit()
        let began = edit.begin(copy)
        #expect(began)
        #expect(edit.phase == .withdrawing)
        #expect(edit.locksComposer(conversation: 7))

        let restored = edit.withdrawn()
        #expect(restored == copy)
        #expect(edit.phase == .idle)
        #expect(!edit.locksComposer(conversation: 7))
        #expect(edit.canBegin)
    }

    /// The input reached the transcript, so there is nothing to put back.
    @Test func sentDoesNotRestoreAnything() {
        var edit = QueuedEdit()
        let began = edit.begin(copy)
        #expect(began)
        edit.alreadySent()

        #expect(edit.phase == .idle)
        #expect(edit.copy == nil)
        let restored = edit.withdrawn()
        #expect(restored == nil)
    }

    /// A dropped connection leaves the outcome unknown: keep the copy, stay
    /// locked, and ask again once the connection is back.
    @Test func disconnectKeepsTheCopyUntilReconnectRetries() {
        var edit = QueuedEdit()
        let began = edit.begin(copy)
        #expect(began)

        let failure = edit.failed(connected: false)
        #expect(failure == .awaitingReconnect)
        #expect(edit.phase == .awaitingReconnect)
        #expect(edit.copy == copy)
        #expect(edit.locksComposer(conversation: 7))
        #expect(!edit.canBegin)

        let offline = edit.retryOnReconnect(connected: false)
        #expect(offline == nil)
        #expect(edit.phase == .awaitingReconnect)
        let retry = edit.retryOnReconnect(connected: true)
        #expect(retry == copy)
        #expect(edit.phase == .withdrawing)
        let restored = edit.withdrawn()
        #expect(restored == copy)
    }

    /// The host refused while the connection stayed up, so nothing was
    /// withdrawn: drop the copy, unlock, and let the row be edited again.
    @Test func rejectionWhileConnectedDropsTheCopyAndUnlocks() {
        var edit = QueuedEdit()
        let began = edit.begin(copy)
        #expect(began)

        let failure = edit.failed(connected: true)
        #expect(failure == .rejected)
        #expect(edit.phase == .idle)
        #expect(edit.copy == nil)
        #expect(!edit.locksComposer(conversation: 7))
        #expect(edit.canBegin)
    }

    @Test func lockingIsScopedToTheCopysConversation() {
        var edit = QueuedEdit()
        let began = edit.begin(copy)
        #expect(began)
        #expect(edit.locksComposer(conversation: 7))
        #expect(!edit.locksComposer(conversation: 8))
    }

    @Test func aSecondEditCannotStartWhileOneIsUnresolved() {
        var edit = QueuedEdit()
        let began = edit.begin(copy)
        #expect(began)
        let other = QueuedEdit.Copy(conversationId: 9, id: 43, text: "other", images: [])

        let second = edit.begin(other)
        #expect(!second)
        #expect(edit.copy == copy)
        #expect(edit.phase == .withdrawing)
    }

    /// A ref copy must be resolved to bytes before the withdraw, because
    /// withdrawing removes the only view the ref was valid through. If any
    /// image fails, the flow stays idle and the row is never withdrawn.
    @Test func failedRefResolutionLeavesTheEditIdleAndWithdrawsNothing() async {
        let refCopy = QueuedEdit.Copy(
            conversationId: 7,
            id: 42,
            text: "edit me",
            images: [
                MessageImage(data: "", mimeType: "image/jpeg", ref: "missing-ref"),
            ]
        )
        var edit = QueuedEdit()
        var withdrew = false

        do {
            let resolved = try await refCopy.resolvingImages { _ in
                throw ResolutionFailure.missing
            }
            _ = edit.begin(resolved)
            withdrew = true
        } catch ResolutionFailure.missing {
            // Expected: the caller must not begin (and so cannot withdraw).
        } catch {
            Issue.record("unexpected error: \(error)")
        }

        #expect(!withdrew)
        #expect(edit.phase == .idle)
        #expect(edit.copy == nil)
        #expect(refCopy.images.first?.ref == "missing-ref")
    }

    @Test func resolvingReplacesEveryRefWithItsBytes() async throws {
        let refCopy = QueuedEdit.Copy(
            conversationId: 7,
            id: 42,
            text: "edit me",
            images: [
                MessageImage(data: "", mimeType: "image/jpeg", ref: "one"),
                MessageImage(data: "already", mimeType: "image/png"),
            ]
        )
        let resolved = try await refCopy.resolvingImages { ref in
            #expect(ref == "one")
            return CachedImage(data: "bytes", mimeType: "image/png")
        }
        #expect(resolved.images.map(\.data) == ["bytes", "already"])
        #expect(resolved.images.allSatisfy { $0.ref == nil })
    }
}

private enum ResolutionFailure: Error {
    case missing
}
