import Foundation
import PinomadCore

/// The fixed attachment limits (issue #321). The host enforces the same
/// values; the client pre-checks so a pick never starts an upload the host
/// must refuse.
public enum AttachmentLimits {
    /// Decoded bytes of one file (10 MiB).
    public static let maxBytes = 10 * 1024 * 1024
    /// Files one message may reference.
    public static let maxPerMessage = 10
    /// Decoded bytes per `appendAttachment` call.
    public static let chunkBytes = 512 * 1024
}

public enum FileAttachmentError: Error, Equatable, LocalizedError {
    case unreadable
    case badReply
    case cancelled
    case noProgress

    public var errorDescription: String? {
        switch self {
        case .unreadable: "Couldn't read the file"
        case .badReply: "The host's reply wasn't an attachment result."
        case .cancelled: "Upload cancelled"
        case .noProgress: "Upload made no progress"
        }
    }
}

/// One picked local file, read on demand. The app copies the bytes out of
/// the security-scoped URL while access is open, so a long upload never
/// depends on a scope that may already have been released.
public final class FileAttachmentSource: Sendable {
    public let name: String
    public let size: Int
    private let read: @Sendable (Int, Int) async throws -> Data

    public init(
        name: String,
        size: Int,
        read: @escaping @Sendable (Int, Int) async throws -> Data
    ) {
        self.name = name
        self.size = size
        self.read = read
    }

    public convenience init(name: String, data: Data) {
        self.init(name: name, size: data.count) { offset, length in
            guard offset >= 0, length >= 0, offset + length <= data.count else {
                throw FileAttachmentError.unreadable
            }
            return data.subdata(in: offset..<(offset + length))
        }
    }

    /// The next chunk. `offset + length <= size` is the caller's contract;
    /// a source that cannot answer fails the upload instead of sending a
    /// short or overlapping chunk.
    public func bytes(offset: Int, length: Int) async throws -> Data {
        guard offset >= 0, length >= 0, offset + length <= size else {
            throw FileAttachmentError.unreadable
        }
        let data = try await read(offset, length)
        guard data.count == length else { throw FileAttachmentError.unreadable }
        return data
    }
}

/// What one `appendAttachment` answered: bytes the host holds now, and
/// whether the promised size was reached.
public struct AttachmentAppend: Equatable, Sendable {
    public let received: Int
    public let complete: Bool

    public init(received: Int, complete: Bool) {
        self.received = received
        self.complete = complete
    }
}

/// The two unbound host calls behind an upload, injected so the loop can be
/// tested without a session.
public struct AttachmentUploadClient: Sendable {
    public let begin: @Sendable (String, Int) async throws -> String
    public let append: @Sendable (String, Int, String) async throws -> AttachmentAppend

    public init(
        begin: @escaping @Sendable (String, Int) async throws -> String,
        append: @escaping @Sendable (String, Int, String) async throws -> AttachmentAppend
    ) {
        self.begin = begin
        self.append = append
    }
}

/// The chunk loop: one await per chunk, resume from the host's `received`,
/// and treat a completed upload as complete whatever offset a retry asks
/// with. A lost reply therefore converges on the next attempt instead of
/// corrupting the file (ADR-0030 §1).
public enum AttachmentUploader {
    @MainActor
    public static func upload(
        _ source: FileAttachmentSource,
        attachmentId: String?,
        received: Int,
        using client: AttachmentUploadClient,
        onId: (String) -> Void = { _ in },
        onProgress: (Int, Bool) -> Void = { _, _ in },
        isCancelled: () -> Bool = { false }
    ) async throws -> (attachmentId: String, received: Int) {
        var attachmentId = attachmentId
        var received = received
        if attachmentId == nil {
            let id = try await client.begin(source.name, source.size)
            attachmentId = id
            onId(id)
        }
        guard let id = attachmentId else { throw FileAttachmentError.badReply }
        if source.size == 0 {
            onProgress(0, true)
            return (id, 0)
        }
        while received < source.size {
            if isCancelled() { throw FileAttachmentError.cancelled }
            let end = min(received + AttachmentLimits.chunkBytes, source.size)
            let data = try await source.bytes(offset: received, length: end - received)
            let result = try await client.append(id, received, data.base64EncodedString())
            if result.complete {
                onProgress(source.size, true)
                return (id, source.size)
            }
            guard result.received > received else { throw FileAttachmentError.noProgress }
            received = result.received
            onProgress(received, false)
        }
        onProgress(source.size, true)
        return (id, source.size)
    }
}

/// The composer's file chips: what was picked, how far each upload got, and
/// the last pick problem. A send only takes `ids()`, so a chip that is
/// uploading or failed can never be referenced by accident.
public struct FileAttachmentTray: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case uploading
        case done
        case failed
    }

    public struct Entry: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let size: Int
        public internal(set) var attachmentId: String?
        public internal(set) var received: Int
        public internal(set) var status: Status
        public internal(set) var error: String?
        /// Nil on a restored queued edit: the bytes already live on the host.
        public let source: FileAttachmentSource?

        public static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.id == rhs.id && lhs.name == rhs.name && lhs.size == rhs.size
                && lhs.attachmentId == rhs.attachmentId && lhs.received == rhs.received
                && lhs.status == rhs.status && lhs.error == rhs.error
                && lhs.source === rhs.source
        }
    }

    public private(set) var entries: [Entry] = []
    public private(set) var error: String?

    public init() {}

    public var isEmpty: Bool { entries.isEmpty }
    public var uploading: Bool { entries.contains { $0.status == .uploading } }
    public var failed: Bool { entries.contains { $0.status == .failed } }
    /// A message may leave only when every chip finished uploading.
    public var canSend: Bool { !uploading && !failed }
    public var room: Int { max(0, AttachmentLimits.maxPerMessage - entries.count) }

    /// Finished ids in chip order — exactly what `submit` references.
    public var ids: [String] {
        entries.compactMap { $0.status == .done ? $0.attachmentId : nil }
    }

    public func entry(_ id: String) -> Entry? {
        entries.first { $0.id == id }
    }

    /// Pre-check a pick, append what fits, and return only the new entries
    /// so the caller can start their uploads.
    @discardableResult
    public mutating func add(_ sources: [FileAttachmentSource]) -> [Entry] {
        guard room > 0 else {
            error = "At most \(AttachmentLimits.maxPerMessage) files per message"
            return []
        }
        var problem: String? = sources.count > room
            ? "At most \(AttachmentLimits.maxPerMessage) files per message"
            : nil
        var kept: [FileAttachmentSource] = []
        for source in sources.prefix(room) {
            if source.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                problem = "Attachment name cannot be empty"
                continue
            }
            if source.size < 0 {
                problem = "Attachment size must be a non-negative integer"
                continue
            }
            if source.size > AttachmentLimits.maxBytes {
                problem = "\(source.name): Attachment is larger than 10 MB"
                continue
            }
            kept.append(source)
        }
        error = problem
        // The chip id is unique for the life of the app, not a per-tray
        // counter: a callback from an upload whose tray was cleared must not
        // be able to land on a new chip that reused the old key.
        let added = kept.map { source in
            Entry(
                id: UUID().uuidString, name: source.name, size: source.size,
                attachmentId: nil, received: 0, status: .uploading, error: nil,
                source: source
            )
        }
        entries += added
        return added
    }

    /// The host named the upload; keep the id so a retry resumes it.
    public mutating func assigned(id: String, attachmentId: String) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index].attachmentId = attachmentId
    }

    public mutating func progress(id: String, received: Int, complete: Bool) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index].received = complete ? entries[index].size : received
        if complete { entries[index].status = .done }
    }

    public mutating func finish(id: String, attachmentId: String, received: Int) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index].attachmentId = attachmentId
        entries[index].received = received
        entries[index].status = .done
        entries[index].error = nil
    }

    /// A failed chunk. `gone` drops the id so the next retry starts a fresh
    /// host upload instead of replaying one the host already cleaned up.
    public mutating func fail(id: String, error message: String, gone: Bool = false) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index].status = .failed
        entries[index].error = message
        if gone {
            entries[index].attachmentId = nil
            entries[index].received = 0
        }
    }

    public mutating func retry(id: String) {
        guard let index = entries.firstIndex(where: { $0.id == id }), entries[index].source != nil else { return }
        entries[index].status = .uploading
        entries[index].error = nil
    }

    public mutating func remove(id: String) {
        entries.removeAll { $0.id == id }
    }

    /// Replace the chips with ids an Edit brings back. They were admitted
    /// before, so the restored set is done without uploads.
    public mutating func restore(_ files: [UserAttachment]) {
        let kept = Array(files.prefix(AttachmentLimits.maxPerMessage))
        entries = kept.map { file in
            Entry(
                id: UUID().uuidString, name: file.name, size: Int(file.size),
                attachmentId: file.id, received: Int(file.size), status: .done,
                error: nil, source: nil
            )
        }
        error = files.count > AttachmentLimits.maxPerMessage
            ? "At most \(AttachmentLimits.maxPerMessage) files per message"
            : nil
    }

    public mutating func report(_ message: String) {
        error = message
    }

    public mutating func clear() {
        entries = []
        error = nil
    }

    /// What the composer shows above the field while an upload is not done.
    public var statusText: String? {
        if uploading { return "Uploading files…" }
        if failed { return "Some files failed to upload — retry or remove them" }
        return nil
    }
}

/// "5 B", "1.2 KB", "3.4 MB" — the same compact style as the Web chips.
public func formatFileSize(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 {
        let value = Double(bytes) / 1024
        return String(format: value < 10 ? "%.1f KB" : "%.0f KB", locale: Locale(identifier: "en_US_POSIX"), value)
    }
    let value = Double(bytes) / (1024 * 1024)
    return String(format: "%.1f MB", locale: Locale(identifier: "en_US_POSIX"), value)
}

/// The percentage a chip paints while uploading; a zero-byte file is
/// complete from the moment the host names it.
public func attachmentPercent(received: Int, size: Int) -> Int {
    guard size > 0 else { return 100 }
    return min(100, Int((Double(received) / Double(size) * 100).rounded()))
}

extension RetryRequest {
    /// The ids a failed run's retry resends (issue #321). Core already
    /// stripped the attachment block from the text, so dropping these would
    /// silently turn the retry into a text-only message.
    public var attachmentIds: [String] { attachments.map(\.id) }
}
