import Foundation
import PinomadChat
import PinomadCore
import UniformTypeIdentifiers

/// Local-file attachments (issue #321): read a picked URL while its security
/// scope is open, upload the bytes in chunks through the unqueued host calls,
/// and keep the chips beside the draft until the reader sends or removes
/// them.
extension AppModel {
    /// Why a picked URL could not become a source. `image` is not an error:
    /// it tells the caller to point at the existing image entry instead.
    private enum PickedFileFailure: Error, Sendable {
        case image
        case message(String)
    }

    /// Read the picked files off the main thread and start their uploads. At
    /// most the free chip slots are read, so a large selection never loads
    /// bytes it can't keep; the security scope is opened and released inside
    /// the read, before the upload starts.
    func attachFiles(conversation key: UInt64, urls: [URL]) {
        guard hostSupports(.attachments) else {
            reportFileProblem(
                conversation: key,
                "Attaching files needs a host on protocol 5.19; run `pinomad upgrade` on the host"
            )
            return
        }
        let tray = fileTrays[key] ?? FileAttachmentTray()
        guard tray.room > 0 else {
            reportFileProblem(
                conversation: key,
                "At most \(AttachmentLimits.maxPerMessage) files per message"
            )
            return
        }
        let room = tray.room
        let selected = Array(urls.prefix(room))
        let overflow = urls.count > room
        let hostKey = currentHostKey
        beginFileRead(key)
        Task { [weak self] in
            let picked = await Task.detached(priority: .userInitiated) {
                selected.map { Self.readPickedFile($0) }
            }.value
            guard let self else { return }
            defer { self.finishFileRead(key) }
            guard self.currentHostKey == hostKey else { return }
            var tray = self.fileTrays[key] ?? FileAttachmentTray()
            var sources: [FileAttachmentSource] = []
            var problem: String? = overflow
                ? "At most \(AttachmentLimits.maxPerMessage) files per message"
                : nil
            var sawImage = false
            for result in picked {
                switch result {
                case let .success(source):
                    sources.append(source)
                case .failure(.image):
                    sawImage = true
                case let .failure(.message(message)):
                    problem = message
                }
            }
            if sawImage {
                problem = problem ?? "Images are attached from Add images…"
            }
            let added = tray.add(sources)
            if let problem { tray.report(problem) }
            self.fileTrays[key] = tray
            for entry in added {
                self.startFileUpload(conversation: key, id: entry.id)
            }
        }
    }

    /// A direct data source, used by the Debug attachment demos and the
    /// simulator end-to-end launch seam.
    func attachFileData(conversation key: UInt64, name: String, data: Data) {
        guard hostSupports(.attachments) else { return }
        var tray = fileTrays[key] ?? FileAttachmentTray()
        let added = tray.add([FileAttachmentSource(name: name, data: data)])
        fileTrays[key] = tray
        for entry in added {
            startFileUpload(conversation: key, id: entry.id)
        }
    }

    func fileTray(for key: UInt64) -> FileAttachmentTray {
        fileTrays[key] ?? FileAttachmentTray()
    }

    /// A pick is still being read off the main actor; a send waits for it.
    func filePreparing(_ key: UInt64) -> Bool {
        (fileReads[key] ?? 0) > 0
    }

    private func beginFileRead(_ key: UInt64) {
        fileReads[key, default: 0] += 1
    }

    private func finishFileRead(_ key: UInt64) {
        guard let count = fileReads[key] else { return }
        if count <= 1 {
            fileReads[key] = nil
        } else {
            fileReads[key] = count - 1
        }
    }

    func retryFile(conversation key: UInt64, id: String) {
        guard var tray = fileTrays[key], tray.entry(id)?.source != nil else { return }
        tray.retry(id: id)
        fileTrays[key] = tray
        startFileUpload(conversation: key, id: id)
    }

    func removeFile(conversation key: UInt64, id: String) {
        guard var tray = fileTrays[key] else { return }
        tray.remove(id: id)
        fileTrays[key] = tray.isEmpty && tray.error == nil ? nil : tray
    }

    func restoreFiles(conversation key: UInt64, attachments: [UserAttachment]) {
        var tray = FileAttachmentTray()
        tray.restore(attachments)
        fileTrays[key] = tray.isEmpty && tray.error == nil ? nil : tray
    }

    func clearFiles(conversation key: UInt64) {
        fileTrays[key] = nil
    }

    func reportFileProblem(conversation key: UInt64, _ message: String) {
        var tray = fileTrays[key] ?? FileAttachmentTray()
        tray.report(message)
        fileTrays[key] = tray
    }

    private func startFileUpload(conversation key: UInt64, id: String) {
        Task { [weak self] in
            await self?.uploadFile(conversation: key, id: id)
        }
    }

    /// One file's chunk loop. Each chunk awaits the previous call, so the
    /// core's single ordered sender is never bypassed (ADR-0024 §3). A dead
    /// session or a removed chip leaves a retryable failed chip behind; a
    /// removed chip is not an error.
    private func uploadFile(conversation key: UInt64, id: String) async {
        guard let session,
              let entry = fileTrays[key]?.entry(id),
              let source = entry.source
        else { return }
        let client = AttachmentUploadClient(
            begin: { name, size in
                let result = try await session.invoke(
                    .beginAttachment(name: name, size: UInt64(max(0, size)))
                )
                guard case let .beginAttachment(attachmentId) = result else {
                    throw FileAttachmentError.badReply
                }
                return attachmentId
            },
            append: { attachmentId, offset, data in
                let result = try await session.invoke(
                    .appendAttachment(
                        attachmentId: attachmentId,
                        offset: UInt64(max(0, offset)),
                        data: data
                    )
                )
                guard case let .appendAttachment(received, complete) = result,
                      let bytes = Int(exactly: received)
                else {
                    throw FileAttachmentError.badReply
                }
                return AttachmentAppend(received: bytes, complete: complete)
            }
        )
        do {
            let result = try await AttachmentUploader.upload(
                source,
                attachmentId: entry.attachmentId,
                received: entry.received,
                using: client,
                onId: { [weak self] attachmentId in
                    self?.fileTrays[key]?.assigned(id: id, attachmentId: attachmentId)
                },
                onProgress: { [weak self] received, complete in
                    self?.fileTrays[key]?.progress(id: id, received: received, complete: complete)
                },
                isCancelled: { [weak self] in
                    self?.fileTrays[key]?.entry(id) == nil
                }
            )
            guard fileTrays[key]?.entry(id) != nil else { return }
            fileTrays[key]?.finish(id: id, attachmentId: result.attachmentId, received: result.received)
        } catch FileAttachmentError.cancelled {
            return
        } catch {
            // A chip removed mid-upload is gone; a live chip (a reconnect or
            // a host refusal) stays and offers Retry.
            guard fileTrays[key]?.entry(id) != nil else { return }
            let message = describe(error)
            let gone = message.range(
                of: "expired|not found", options: [.regularExpression, .caseInsensitive]
            ) != nil
            fileTrays[key]?.fail(id: id, error: message, gone: gone)
        }
    }

    /// Read one URL under its security scope and copy the bytes out before
    /// the scope closes — an upload never depends on a picker's access lease.
    private nonisolated static func readPickedFile(
        _ url: URL
    ) -> Result<FileAttachmentSource, PickedFileFailure> {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
        do {
            let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey, .isRegularFileKey])
            if values.isRegularFile == false {
                return .failure(.message("\(url.lastPathComponent): Not a regular file"))
            }
            let type = values.contentType ?? UTType(filenameExtension: url.pathExtension)
            if type?.conforms(to: .image) == true {
                return .failure(.image)
            }
            if let size = values.fileSize, size > AttachmentLimits.maxBytes {
                return .failure(.message("\(url.lastPathComponent): Attachment is larger than 10 MB"))
            }
            // A copy, not a mapped file: the security scope is released
            // before the upload reads its chunks.
            let data = try Data(contentsOf: url)
            guard data.count <= AttachmentLimits.maxBytes else {
                return .failure(.message("\(url.lastPathComponent): Attachment is larger than 10 MB"))
            }
            return .success(FileAttachmentSource(name: url.lastPathComponent, data: data))
        } catch {
            return .failure(.message("\(url.lastPathComponent): \(error.localizedDescription)"))
        }
    }
}
