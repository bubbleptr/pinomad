import PinomadCore

/// How a message's delivery reads in the transcript. The host's own facts
/// come first: a queue row is sent (one check), the newest committed user
/// bubble is delivered (two checks). A local send shows its phase until the
/// host replaces it (ADR-0034 §5).
public enum MessageStatus: Equatable, Sendable {
    /// In the client queue or on the wire, no result yet.
    case sending
    /// The host admitted it into its inbox (one check).
    case sent
    /// On the wire with no answer, or the carrier dropped (ADR-0034 §7).
    case unknown
    /// The host refused admission.
    case failed
    /// The host wrote the real `pi.user` entry (two checks).
    case delivered

    /// Keeps the FFI enum the single source of the phase set.
    public init(_ status: SubmissionStatus) {
        switch status {
        case .sending: self = .sending
        case .unknown: self = .unknown
        case .failed: self = .failed
        }
    }

    /// The caption beside a clock icon; everything else is the icon alone.
    public var caption: String? {
        self == .unknown ? "Not confirmed" : nil
    }
}

/// One send the host has not acknowledged yet, rendered after the committed
/// transcript. It carries everything the bubble draws, plus the retry/Edit
/// identity.
public struct LocalMessage: Equatable, Sendable, Identifiable {
    public let requestId: String
    public let text: String
    public let images: [MessageImage]
    public let skills: [String]
    /// The composer's file chips, keyed by the request id it sent them with.
    public let attachments: [UserAttachment]
    public let status: MessageStatus
    public let error: String?

    public var id: String { "local:\(requestId)" }

    public init(
        requestId: String,
        text: String,
        images: [MessageImage],
        skills: [String],
        attachments: [UserAttachment] = [],
        status: MessageStatus,
        error: String? = nil
    ) {
        self.requestId = requestId
        self.text = text
        self.images = images
        self.skills = skills
        self.attachments = attachments
        self.status = status
        self.error = error
    }
}

/// One transcript row: a committed entry with the delivery mark when it is
/// the newest committed user bubble, or a local send with its own phase.
public enum TranscriptRow: Equatable, Sendable, Identifiable {
    case entry(ChatEntry, status: MessageStatus?)
    case local(LocalMessage)

    public var id: String {
        switch self {
        case let .entry(entry, _): entry.entryId
        case let .local(message): message.id
        }
    }
}

public enum Transcript {
    /// The committed entries in order, then the local sends. Only the newest
    /// committed user bubble gets the delivered mark — local rows are
    /// appended after that decision so they can never take it over.
    public static func rows(
        chat: [ChatEntry],
        local: [LocalSubmission],
        attachmentDetails: [String: [UserAttachment]] = [:]
    ) -> [TranscriptRow] {
        let newestUser = chat.last(where: { entry in
            if case .user = entry { true } else { false }
        })?.entryId
        var rows = chat.map { entry -> TranscriptRow in
            guard case .user = entry else { return .entry(entry, status: nil) }
            return .entry(entry, status: entry.entryId == newestUser ? .delivered : nil)
        }
        rows += local.map { submission in
            .local(LocalMessage(
                requestId: submission.requestId,
                text: submission.text,
                images: submission.images,
                skills: submission.skills,
                attachments: attachmentDetails[submission.requestId] ?? [],
                status: MessageStatus(submission.status),
                error: submission.error
            ))
        }
        return rows
    }
}
