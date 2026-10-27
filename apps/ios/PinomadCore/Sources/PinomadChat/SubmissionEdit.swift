import PinomadCore

/// Whether a send's Edit affordance is available, and why not. Restoring a
/// send overwrites the composer, so it waits for an empty one; only one
/// take-back may be unresolved at a time.
public struct EditAvailability: Equatable, Sendable {
    public enum Reason: Equatable, Sendable {
        /// The composer already holds text, images or files.
        case composerOccupied
        /// Another Edit is still resolving.
        case anotherEditInFlight
    }

    public let reason: Reason?

    public var isDisabled: Bool { reason != nil }

    public var tooltip: String? {
        switch reason {
        case .composerOccupied: "Clear the composer to edit"
        case .anotherEditInFlight: "Finish the current edit first"
        case nil: nil
        }
    }

    public init(
        draft: String,
        hasImages: Bool,
        hasFiles: Bool,
        preparing: Bool,
        anotherEdit: Bool
    ) {
        let occupied = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || hasImages || hasFiles || preparing
        if occupied {
            reason = .composerOccupied
        } else if anotherEdit {
            reason = .anotherEditInFlight
        } else {
            reason = nil
        }
    }
}

/// A draft taken back from the transcript, bound to the conversation it came
/// from: switching away must not fill another composer. The Web's
/// `take-back.ts` pair.
public struct PendingTakeBack: Equatable, Sendable {
    public let conversationId: UInt64
    public let draft: SubmissionDraft

    public init(conversationId: UInt64, draft: SubmissionDraft) {
        self.conversationId = conversationId
        self.draft = draft
    }

    /// The draft only belongs to its origin conversation.
    public func draft(for conversationId: UInt64?) -> SubmissionDraft? {
        self.conversationId == conversationId ? draft : nil
    }
}

public extension SubmissionDraft {
    /// Resolve a taken-back send's ref images before refilling the composer
    /// (ADR-0027 §5). The local row is already gone, so a failure only drops
    /// the images from the restore, not the text.
    func resolvingImages(
        using load: @escaping @Sendable (String, ImageVariant) async throws -> CachedImage
    ) async throws -> [MessageImage] {
        try await images.resolving(using: load)
    }
}

public extension Array where Element == MessageImage {
    /// Inline bytes pass through; a ref is read before its stream may go
    /// away. Used by both the queued-input and the local-send Edit flows.
    func resolving(
        using load: @escaping @Sendable (String, ImageVariant) async throws -> CachedImage
    ) async throws -> [MessageImage] {
        var resolved: [MessageImage] = []
        resolved.reserveCapacity(count)
        for image in self {
            if !image.data.isEmpty {
                resolved.append(image)
                continue
            }
            guard let ref = image.ref, !ref.isEmpty else {
                throw QueuedEditImageError.missingReference
            }
            let bytes = try await load(ref, .original)
            resolved.append(MessageImage(data: bytes.data, mimeType: bytes.mimeType))
        }
        return resolved
    }
}
