import PinomadCore

/// The Edit flow for one queued input: the content read before withdrawing,
/// and the locked states around the request. It is plain value state so the
/// app can drive the call and tests can pin the rules the Web composer
/// settled on (its `editCopy` / `awaitingEdit` pair).
public struct QueuedEdit: Equatable, Sendable {
    /// What a successful withdraw puts back into the composer.
    public struct Copy: Equatable, Sendable {
        public let conversationId: UInt64
        public let id: UInt64
        public let text: String
        public let images: [MessageImage]
        /// The skills the host expanded (ADR-0028); their `$name` mentions
        /// come back as chips.
        public let skills: [String]
        /// Host-stored files on the queued input (issue #321). They go back
        /// on the resend as ids; re-uploading would duplicate the bytes.
        public let attachments: [UserAttachment]

        public init(conversationId: UInt64, id: UInt64, text: String, images: [MessageImage],
                    skills: [String] = [], attachments: [UserAttachment] = []) {
            self.conversationId = conversationId
            self.id = id
            self.text = text
            self.images = images
            self.skills = skills
            self.attachments = attachments
        }

        /// What `submit` references on the resend.
        public var attachmentIds: [String] { attachments.map(\.id) }
    }

    public enum Phase: Equatable, Sendable {
        case idle
        /// One withdraw request is in flight.
        case withdrawing
        /// The connection dropped before the outcome arrived. The host's
        /// withdraw is idempotent, so a reconnect asks again by id even if
        /// the row has already disappeared.
        case awaitingReconnect
    }

    public enum Failure: Equatable, Sendable {
        /// The connection stayed up, so the host refused and nothing was
        /// withdrawn: the copy is gone and the composer is unlocked.
        case rejected
        /// The connection was gone when the call failed; the outcome is
        /// unknown, so the copy is kept and the composer stays locked.
        case awaitingReconnect
    }

    public private(set) var copy: Copy?
    public private(set) var phase: Phase = .idle

    public init() {}

    /// Edit is available again only after the current copy is resolved.
    public var canBegin: Bool { phase == .idle }

    /// Whether a conversation's composer (and its attachment entry points)
    /// must stay locked. Another conversation is unaffected.
    public func locksComposer(conversation id: UInt64) -> Bool {
        phase != .idle && copy?.conversationId == id
    }

    /// Keep the pre-withdraw copy and start the request. False while another
    /// Edit is still unresolved — one copy at a time.
    public mutating func begin(_ copy: Copy) -> Bool {
        guard phase == .idle else { return false }
        self.copy = copy
        phase = .withdrawing
        return true
    }

    /// The host withdrew it: hand back the copy to refill and unlock.
    public mutating func withdrawn() -> Copy? {
        guard phase == .withdrawing, let copy else { return nil }
        reset()
        return copy
    }

    /// It reached the transcript first, so there is nothing to refill.
    public mutating func alreadySent() {
        guard phase == .withdrawing else { return }
        reset()
    }

    /// A failed withdraw. Only the live connection state decides whether the
    /// outcome is unknown; an explicit host refusal leaves the row queued.
    @discardableResult
    public mutating func failed(connected: Bool) -> Failure {
        guard copy != nil else { return .rejected }
        guard !connected else {
            reset()
            return .rejected
        }
        phase = .awaitingReconnect
        return .awaitingReconnect
    }

    /// The reconnect retry trigger. Returns the copy whose withdraw must run
    /// again, or nil while still offline or with nothing pending.
    public mutating func retryOnReconnect(connected: Bool) -> Copy? {
        guard connected, phase == .awaitingReconnect, let copy else { return nil }
        phase = .withdrawing
        return copy
    }

    /// Drop the flow — a host switch, or a copy that no longer applies.
    public mutating func reset() {
        copy = nil
        phase = .idle
    }
}

public enum QueuedEditImageError: Error, Equatable {
    case missingReference
}

extension QueuedEdit.Copy {
    /// Resolve every ref in the queued copy to bytes before the withdraw.
    /// A ref is valid only while its stream is subscribed; withdrawing first
    /// would make it unresolvable (ADR-0027 §5). All-or-nothing: one failure
    /// throws and the caller keeps the row queued.
    public func resolvingImages(
        using load: @escaping @Sendable (String, ImageVariant) async throws -> CachedImage
    ) async throws -> QueuedEdit.Copy {
        let resolved = try await images.resolving(using: load)
        return QueuedEdit.Copy(
            conversationId: conversationId,
            id: id,
            text: text,
            images: resolved,
            skills: skills,
            attachments: attachments
        )
    }
}
