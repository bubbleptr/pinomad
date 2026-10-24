import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func bytes(_ count: Int) -> Data {
    Data((0..<count).map { UInt8($0 % 251) })
}

private func source(_ count: Int, name: String = "notes.txt") -> FileAttachmentSource {
    FileAttachmentSource(name: name, data: bytes(count))
}

/// Deterministic host: replies are consumed in call order, and every chunk
/// is recorded so a test can pin offsets and decoded sizes without sleeping.
private actor UploadSpy {
    enum Reply {
        case id(String)
        case append(AttachmentAppend)
        case failure(any Error)
    }

    private var replies: [Reply]
    private(set) var begins: [(String, Int)] = []
    private(set) var appends: [(String, Int, String)] = []

    init(_ replies: [Reply]) {
        self.replies = replies
    }

    var offsets: [Int] { appends.map(\.1) }
    var decodedSizes: [Int] { appends.map { Data(base64Encoded: $0.2)?.count ?? -1 } }

    func client() -> AttachmentUploadClient {
        AttachmentUploadClient(
            begin: { name, size in try await self.begin(name, size) },
            append: { id, offset, data in try await self.append(id, offset, data) }
        )
    }

    private func next() throws -> Reply {
        guard !replies.isEmpty else { throw FileAttachmentError.badReply }
        return replies.removeFirst()
    }

    private func begin(_ name: String, _ size: Int) throws -> String {
        begins.append((name, size))
        guard case let .id(id) = try next() else { throw FileAttachmentError.badReply }
        return id
    }

    private func append(_ id: String, _ offset: Int, _ data: String) throws -> AttachmentAppend {
        appends.append((id, offset, data))
        switch try next() {
        case let .append(result): return result
        case let .failure(error): throw error
        default: throw FileAttachmentError.badReply
        }
    }
}

@MainActor
@Suite struct FileAttachmentUploadTests {
    private let hostId = String(repeating: "A", count: 22)

    @Test func uploadsChunksOfAtMost512KiBAndFollowsTheHostsReceived() async throws {
        let spy = UploadSpy([
            .id(hostId),
            .append(AttachmentAppend(received: 512 * 1024, complete: false)),
            .append(AttachmentAppend(received: 700_000, complete: true)),
        ])
        var progress: [(Int, Bool)] = []
        var named: String?
        let result = try await AttachmentUploader.upload(
            source(700_000), attachmentId: nil, received: 0, using: await spy.client(),
            onId: { named = $0 },
            onProgress: { progress.append(($0, $1)) }
        )
        #expect(result.attachmentId == hostId)
        #expect(result.received == 700_000)
        #expect(named == hostId)
        let offsets = await spy.offsets
        #expect(offsets == [0, 512 * 1024])
        let sizes = await spy.decodedSizes
        #expect(sizes.allSatisfy { $0 <= AttachmentLimits.chunkBytes })
        #expect(progress.last?.0 == 700_000)
        #expect(progress.last?.1 == true)
    }

    /// The host wrote the whole file but the completion reply was lost. A
    /// retry keeps the id and asks from the last known offset; the host's
    /// answer is authoritative.
    @Test func aLostCompletionReplyIsRecoveredByRequeryingTheSameId() async throws {
        let spy = UploadSpy([.append(AttachmentAppend(received: 5, complete: true))])
        let result = try await AttachmentUploader.upload(
            source(5), attachmentId: hostId, received: 0, using: await spy.client()
        )
        #expect(result.attachmentId == hostId)
        #expect(result.received == 5)
        let begins = await spy.begins
        #expect(begins.isEmpty)
        let offsets = await spy.offsets
        #expect(offsets == [0])
    }

    /// A chunk that fails marks the upload failed; the caller retries with
    /// the id and offset the host last confirmed.
    @Test func aFailedChunkSurfacesWithoutCreatingAnotherUpload() async throws {
        let spy = UploadSpy([
            .id(hostId),
            .append(AttachmentAppend(received: 1024, complete: false)),
            .failure(URLError(.networkConnectionLost)),
        ])
        await #expect(throws: URLError.self) {
            try await AttachmentUploader.upload(
                source(4096), attachmentId: nil, received: 0, using: await spy.client()
            )
        }
        let begins = await spy.begins
        #expect(begins.count == 1)
        let offsets = await spy.offsets
        #expect(offsets == [0, 1024])
    }

    @Test func aZeroByteFileCompletesAtBegin() async throws {
        let spy = UploadSpy([.id(hostId)])
        var progress: [(Int, Bool)] = []
        let result = try await AttachmentUploader.upload(
            source(0), attachmentId: nil, received: 0, using: await spy.client(),
            onProgress: { progress.append(($0, $1)) }
        )
        #expect(result.received == 0)
        let appends = await spy.appends
        #expect(appends.isEmpty)
        #expect(progress.last?.0 == 0)
        #expect(progress.last?.1 == true)
    }

    /// Removing the chip makes the next loop check stop — the in-flight
    /// chunk is the last one sent.
    @Test func cancellingStopsBeforeTheNextChunk() async throws {
        let spy = UploadSpy([.append(AttachmentAppend(received: 1024, complete: false))])
        var cancelled = false
        await #expect(throws: FileAttachmentError.cancelled) {
            try await AttachmentUploader.upload(
                source(4096), attachmentId: hostId, received: 0, using: await spy.client(),
                onProgress: { _, _ in cancelled = true },
                isCancelled: { cancelled }
            )
        }
        let offsets = await spy.offsets
        #expect(offsets == [0])
    }
}

@Suite struct FileAttachmentTrayTests {
    @Test func aPickKeepsWhatFitsAndReportsCountAndSizeProblems() {
        var tray = FileAttachmentTray()
        let added = tray.add((0..<12).map { FileAttachmentSource(name: "f\($0).txt", data: Data("x".utf8)) })
        #expect(added.count == 10)
        #expect(tray.entries.count == 10)
        #expect(tray.error == "At most 10 files per message")

        var oversized = FileAttachmentTray()
        let huge = FileAttachmentSource(name: "huge.bin", size: AttachmentLimits.maxBytes + 1) { _, _ in Data() }
        #expect(oversized.add([huge]).isEmpty)
        #expect(oversized.error == "huge.bin: Attachment is larger than 10 MB")
    }

    /// A batch must never share one chip id: uploads look entries up by id,
    /// so duplicates would drive only the first file and leave the rest
    /// uploading forever.
    @Test func everyPickedFileGetsItsOwnChipId() {
        var tray = FileAttachmentTray()
        let added = tray.add([
            source(1, name: "a.txt"), source(2, name: "b.txt"), source(3, name: "c.txt"),
        ])
        #expect(added.count == 3)
        #expect(Set(added.map(\.id)).count == 3)
    }

    /// A cleared tray's old upload callbacks must not match a new chip, even
    /// when the new tray starts its own numbering.
    @Test func chipKeysAreNotReusedAfterAClear() throws {
        var tray = FileAttachmentTray()
        let old = try #require(tray.add([source(1)])[0])
        tray.clear()
        let new = try #require(tray.add([source(1)])[0])
        #expect(old.id != new.id)
    }

    @Test func chipsTrackProgressFailureRetryAndRemoval() throws {
        var tray = FileAttachmentTray()
        let added = tray.add([source(5, name: "a.txt")])
        let entry = try #require(added.first)
        #expect(tray.uploading)
        #expect(tray.statusText == "Uploading files…")
        #expect(!tray.canSend)
        #expect(tray.ids.isEmpty)

        tray.progress(id: entry.id, received: 3, complete: false)
        #expect(tray.entry(entry.id)?.received == 3)
        tray.finish(id: entry.id, attachmentId: String(repeating: "A", count: 22), received: 5)
        #expect(tray.entries.first?.status == .done)
        #expect(tray.ids == [String(repeating: "A", count: 22)])
        #expect(tray.canSend)
        #expect(tray.statusText == nil)

        tray.remove(id: entry.id)
        #expect(tray.isEmpty)
    }

    @Test func aFailedChipCanRetryAndADeadIdStartsOver() {
        var tray = FileAttachmentTray()
        let entry = tray.add([source(5)])[0]
        tray.finish(id: entry.id, attachmentId: String(repeating: "A", count: 22), received: 5)
        tray.fail(id: entry.id, error: "network down")
        #expect(tray.failed)
        #expect(tray.statusText == "Some files failed to upload — retry or remove them")
        #expect(!tray.canSend)

        tray.retry(id: entry.id)
        #expect(tray.uploading)
        #expect(tray.entry(entry.id)?.attachmentId == String(repeating: "A", count: 22))

        // The host expired the upload: the id and offset reset so the retry
        // begins a fresh one.
        tray.fail(id: entry.id, error: "Attachment not found or expired", gone: true)
        #expect(tray.entry(entry.id)?.attachmentId == nil)
        #expect(tray.entry(entry.id)?.received == 0)
    }

    @Test func aQueuedEditRestoresFinishedIdsWithoutBytes() {
        var tray = FileAttachmentTray()
        tray.restore([
            UserAttachment(id: String(repeating: "B", count: 22), name: "old.log", size: 42),
            UserAttachment(id: String(repeating: "C", count: 22), name: "empty.txt", size: 0),
        ])
        #expect(tray.ids == [String(repeating: "B", count: 22), String(repeating: "C", count: 22)])
        #expect(tray.canSend)
        #expect(tray.entries.map(\.size) == [42, 0])
    }

    @Test func formatsSizesLikeTheWebChips() {
        #expect(formatFileSize(0) == "0 B")
        #expect(formatFileSize(1023) == "1023 B")
        #expect(formatFileSize(1024) == "1.0 KB")
        #expect(formatFileSize(12 * 1024) == "12 KB")
        #expect(formatFileSize(3_500_000) == "3.3 MB")
        #expect(attachmentPercent(received: 0, size: 0) == 100)
        #expect(attachmentPercent(received: 512, size: 1024) == 50)
    }
}

@Suite struct FileSendGateTests {
    @Test func filesAloneCanBeSent() {
        #expect(SendSlot(draft: "", connected: true, busy: false, hasFiles: true)
            == .send(enabled: true, canSteer: false))
    }

    @Test func uploadingOrFailedFilesBlockSendOnly() {
        #expect(SendSlot(draft: "hi", connected: true, busy: false,
                         hasFiles: true, filesBlocked: true)
            == .send(enabled: false, canSteer: false))
        #expect(SendSlot(draft: "", connected: true, busy: true,
                         hasFiles: true, filesBlocked: true)
            == .stop(enabled: true))
    }

    @Test func commandsCannotCarryFiles() {
        let commands = [CommandEntry(
            name: "compact", description: "Summarize", argumentHint: nil,
            source: .builtin, disabled: nil
        )]
        #expect(ComposerSubmit(draft: "/compact", commands: commands,
                               hasImages: false, hasFiles: true)
            == .blocked(reason: "Commands can't include files. Remove them to run /compact."))
    }
}

@Suite struct AttachmentResendTests {
    @Test func aQueuedEditKeepsItsAttachmentIdsThroughImageResolution() async throws {
        let file = UserAttachment(id: String(repeating: "D", count: 22), name: "a.log", size: 12)
        let copy = QueuedEdit.Copy(
            conversationId: 7, id: 42, text: "look", images: [], attachments: [file]
        )
        let resolved = try await copy.resolvingImages { _ in
            CachedImage(data: "bytes", mimeType: "image/png")
        }
        #expect(resolved.attachmentIds == [file.id])
        #expect(resolved == copy)
    }

    @Test func aRetryCarriesTheAttachmentsCoreKept() {
        let file = UserAttachment(id: String(repeating: "E", count: 22), name: "b.log", size: 7)
        let request = RetryRequest(
            text: "look", images: [], skills: [], attachments: [file],
            requestId: "retry:run-1"
        )
        #expect(request.attachmentIds == [file.id])
    }
}
