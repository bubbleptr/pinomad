import AgentChatCore
import AgentChatKit
import Foundation
import PinomadChat
import PinomadCore
import UIKit

/// The composer's calls. All command-class: a host refusal resolves
/// normally and surfaces as a notice toast, so only a dead session
/// (thrown) needs handling here.
extension AppModel {
    /// The local retry's own deadline; see `retrySubmission`.
    private struct SubmissionTimeout: Error {}
    /// Send the conversation's draft. Idle → a plain prompt; busy → `mode`
    /// decides between steering the run and queueing a follow-up. The draft
    /// clears at once; a refused send is a local row with its own Retry
    /// (ADR-0034 §5), not a second copy in the composer.
    func send(conversation id: UInt64, mode: SubmitMode) {
        let text = drafts[id] ?? ""
        let tray = trays[id] ?? AttachmentTray()
        var files = fileTrays[id] ?? FileAttachmentTray()
        guard !text.allSatisfy(\.isWhitespace) || !tray.images.isEmpty || !files.isEmpty,
              tray.preparing == 0, files.canSend, !filePreparing(id), let session else { return }
        // Past the host's 24 h TTL the id may already be gone; drop it and
        // keep the source so Retry re-uploads instead of losing the draft.
        if files.expire() {
            fileTrays[id] = files
            lastError = "Attachment expired; attach it again"
            return
        }
        let images = tray.images
        let requestId = UUID().uuidString
        let sentFiles = files.attachments
        let attachments = sentFiles.map(\.id)
        let chips = chips(for: id)
        let payload = chips.payload(hostMinor: hostMinor)
        if !sentFiles.isEmpty { sentFileDetails[requestId] = sentFiles }
        drafts[id] = ""
        skillChips[id] = nil
        trays[id] = nil
        fileTrays[id] = nil
        transcriptPin += 1
        Task { [weak self] in
            do {
                _ = try await session.invoke(
                    .submit(text: payload.text, whenBusy: mode, target: id, requestId: requestId,
                            images: images, skills: payload.skills, attachments: attachments))
            } catch {
                // The local submission owns a host refusal (ADR-0034 §5):
                // putting the draft back would leave two resendable copies.
                // Only a session that ended before admitting the call has no
                // row, and there is no composer left to restore into then.
                guard let self else { return }
                self.showToast("Couldn't send: \(self.describe(error))", level: "error")
            }
        }
    }

    /// Stage images for a conversation: slots are claimed now, the bytes
    /// are read and re-encoded off the main actor, and the batch lands (or
    /// fails as a whole) when every image is ready.
    func attach(conversation id: UInt64, accepts: Bool, sources: [@Sendable () async throws -> Data]) {
        var tray = trays[id] ?? AttachmentTray()
        let claim = tray.reserve(sources.count, accepts: accepts)
        trays[id] = tray
        guard let claim else { return }
        let kept = Array(sources.prefix(claim.count))
        transcriptPin += 1
        Task { [weak self] in
            do {
                var prepared: [MessageImage] = []
                for load in kept {
                    let data = try await load()
                    prepared.append(try await Task.detached { try ImagePrep.prepare(data) }.value)
                }
                guard let self else { return }
                // The first snapshot naming these bytes should hit the local
                // cache, not download the attachment back from the host.
                for image in prepared {
                    await self.images.prefill(CachedImage(data: image.data, mimeType: image.mimeType))
                }
                self.trays[id]?.fulfil(claim, with: prepared)
            } catch {
                self?.trays[id]?.fail(claim, message: (error as? ImagePrep.Failure)?.description ?? "Couldn't read the image")
            }
        }
    }

    /// Stage the clipboard's image, or say there isn't one.
    func pasteImage(into id: UInt64, accepts: Bool) {
        // `hasImages` doesn't trigger the paste prompt; reading does.
        guard UIPasteboard.general.hasImages,
              let data = UIPasteboard.general.image?.jpegData(compressionQuality: 1)
        else {
            reportAttachProblem(conversation: id, "No image on the clipboard")
            return
        }
        attach(conversation: id, accepts: accepts, sources: [{ @Sendable in data }])
    }

    var hostMinor: UInt32 { snapshot?.host?.protocol.minor ?? 0 }

    /// The draft's bound skills, moved onto its current text: any change
    /// since they were stored (typing, a menu insertion, a clear) shifts
    /// or unbinds them.
    func chips(for id: UInt64) -> SkillChips {
        (skillChips[id] ?? SkillChips()).following(drafts[id] ?? "")
    }

    /// Store the chips against the current text — called on every draft
    /// change, so each step is one edit to follow.
    func syncChips(_ id: UInt64) {
        let chips = chips(for: id)
        if skillChips[id] != chips { skillChips[id] = chips }
    }

    /// A `$` menu pick: bind the `$name` now in the draft at `location`.
    func bindSkillChip(_ name: String, at location: Int, in id: UInt64) {
        var chips = chips(for: id)
        chips.bind(name, at: location)
        skillChips[id] = chips
    }

    func removeImage(conversation id: UInt64, at index: Int) {
        trays[id]?.remove(at: index)
    }

    func reportAttachProblem(conversation id: UInt64, _ message: String) {
        var tray = trays[id] ?? AttachmentTray()
        tray.report(message)
        trays[id] = tray
    }

    /// Answer every question of a pending request at once. The card goes
    /// away when the snapshot marks the request resolved; the draft is kept
    /// until then so a refused answer (toasted) can be resent. Returns once
    /// the host took or refused it, so the card can hold Submit meanwhile.
    func answer(_ question: PendingQuestion, conversation id: UInt64) async {
        let draft = questionDrafts[question.request.id]
            ?? QuestionDraft(questionCount: question.request.questions.count)
        guard let session else { return }
        _ = try? await session.invoke(.answer(kind: question.kind, requestId: question.request.id,
                                              answers: draft.answers(), target: id))
    }

    /// Resend a failed run's prompt. The request id is derived from the run,
    /// so a double tap or another client's retry is admitted once. The picked
    /// skills go back too, or the host would match every `$name` in the text.
    func retry(_ request: RetryRequest, conversation id: UInt64) {
        transcriptPin += 1
        if !request.attachments.isEmpty {
            sentFileDetails[request.requestId] = request.attachments
        }
        // The host stripped the attachment block from the text; resend the
        // ids core kept or the retry silently becomes text-only (#321).
        run(.submit(text: request.text, whenBusy: .followUp, target: id,
                    requestId: request.requestId, images: request.images,
                    skills: request.skills, attachments: request.attachmentIds))
    }

    func stop(conversation id: UInt64) {
        run(.abort(target: id))
    }

    func compact() {
        run(.compact(instructions: nil))
    }

    func setModel(_ model: ModelRef) {
        run(.setModel(model: model))
    }

    /// Switch the shown conversation's named agent, or clear it. Like
    /// `setModel`, a host refusal comes back as a notice; the sheet's
    /// selection reads the next snapshot, so it never sticks by itself.
    func setAgent(_ agent: String?) {
        run(.setAgent(agent: agent))
    }

    func setThinkingLevel(_ level: ThinkingLevel) {
        run(.setThinkingLevel(level: level))
    }

    func dismissToast(_ id: UInt64) {
        toasts.removeAll { $0.id == id }
    }

    /// Queue a notice as a toast that clears itself; at most three stay up.
    func show(_ notice: Notice) {
        toasts.append(notice)
        if toasts.count > 3 { toasts.removeFirst(toasts.count - 3) }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.dismissToast(notice.id)
        }
    }

    /// A notice the app produced itself (the queued actions' outcomes and
    /// refusals). The descending id keeps it out of the core notice feed.
    func showToast(_ message: String, level: String = "info") {
        localToastID &-= 1
        show(Notice(id: localToastID, level: level, message: message))
    }

    // ── Queued inputs (#144) ────────────────────────────────────────────
    // Withdraw and steer are request-class: their outcome and any host
    // refusal come back here, not as a notice. One request per row at a
    // time; the Edit copy locks the composer until it is resolved.

    func queuedEditLocksComposer(conversation id: UInt64) -> Bool {
        queuedEdit.locksComposer(conversation: id) || queuedEditPreparing.contains(id)
            || takingBack == id
    }

    /// Editing restores a send over the composer, so it waits for an empty
    /// composer and for any other Edit to resolve. Local sends and host
    /// queued rows share this rule.
    func editAvailability(conversation id: UInt64) -> EditAvailability {
        let text = drafts[id] ?? ""
        let tray = trays[id] ?? AttachmentTray()
        let files = fileTrays[id] ?? FileAttachmentTray()
        return EditAvailability(
            draft: text,
            hasImages: !tray.images.isEmpty,
            hasFiles: !files.isEmpty,
            preparing: tray.preparing > 0 || filePreparing(id),
            anotherEdit: !queuedEdit.canBegin || !queuedEditPreparing.isEmpty || takingBack != nil
        )
    }

    func queuedEditDisabled(conversation id: UInt64) -> Bool {
        editAvailability(conversation: id).isDisabled
    }

    // ── Local sends (#402/#406) ─────────────────────────────────────────
    // Retry and take-back are core-local actions on a logical submission
    // (ADR-0034 §11). The row carries the requestId, so neither reads the
    // conversation's current content.

    private func beginSubmissionAction(_ requestId: String) -> UUID? {
        guard submissionPending.insert(requestId).inserted else { return nil }
        let token = UUID()
        submissionTokens[requestId] = token
        return token
    }

    private func endSubmissionAction(_ requestId: String, token: UUID) {
        guard submissionTokens[requestId] == token else { return }
        submissionTokens.removeValue(forKey: requestId)
        submissionPending.remove(requestId)
    }

    /// Resend a failed or unconfirmed local send with its original key; the
    /// core queries before resending when the outcome is unknown.
    func retrySubmission(conversation id: UInt64, requestId: String) {
        guard connected, let session, let token = beginSubmissionAction(requestId) else { return }
        let generation = sessionGeneration
        Task { [weak self] in
            guard let self else { return }
            defer {
                if self.sessionGeneration == generation {
                    self.endSubmissionAction(requestId, token: token)
                }
            }
            do {
                // The controller's query-then-resend is not an op it can
                // time out: a host that never answers would leave the invoke
                // pending while the row turns unknown. Cancel the invoke on
                // the same window so the session lets the op go and Retry is
                // reachable again; the token keeps the release from
                // unlocking a newer retry.
                _ = try await withThrowingTaskGroup(of: CallResult.self) { group in
                    group.addTask {
                        try await session.invoke(.retrySubmission(requestId: requestId))
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(35))
                        throw SubmissionTimeout()
                    }
                    defer { group.cancelAll() }
                    guard let result = try await group.next() else { throw SubmissionTimeout() }
                    return result
                }
            } catch is SubmissionTimeout {
                // The row already reads "unknown"; releasing the lock is all
                // this needs to do.
            } catch {
                guard self.sessionGeneration == generation else { return }
                self.showToast(self.describe(error), level: "error")
            }
        }
    }

    /// Take a failed or unconfirmed local send back for editing. The draft
    /// lands only in the conversation that sent it, even if the reader
    /// switched away; its ref images are read while the source entries are
    /// still subscribed.
    func editSubmission(conversation id: UInt64, requestId: String) {
        guard connected, let session, takingBack == nil,
              !editAvailability(conversation: id).isDisabled,
              let token = beginSubmissionAction(requestId)
        else { return }
        takingBack = id
        let generation = sessionGeneration
        Task { [weak self] in
            guard let self else { return }
            defer {
                if self.sessionGeneration == generation {
                    if self.takingBack == id { self.takingBack = nil }
                    self.endSubmissionAction(requestId, token: token)
                }
            }
            do {
                let result = try await session.invoke(
                    .takeBackSubmission(requestId: requestId))
                guard self.session === session, self.sessionGeneration == generation,
                      case let .takeBackSubmission(draft) = result, let draft
                else { return }
                var images: [MessageImage] = []
                do {
                    images = try await draft.images.resolving { ref, variant in
                        try await self.cachedImage(ref: ref, variant: variant, session: session)
                    }
                } catch {
                    // The text and file chips are still worth restoring; the
                    // source image ref left the live view. A replaced host is
                    // not this task's to fill.
                    guard self.session === session, self.sessionGeneration == generation
                    else { return }
                    self.showToast(
                        "Couldn't load the original images; the message text is back.",
                        level: "error")
                }
                guard self.session === session, self.sessionGeneration == generation else { return }
                self.putBack(PendingTakeBack(conversationId: id, draft: draft),
                             requestId: requestId, images: images)
            } catch {
                guard self.session === session, self.sessionGeneration == generation else { return }
                self.showToast("Couldn't take the message back: \(self.describe(error))",
                               level: "error")
            }
        }
    }

    /// Refill the origin conversation's composer with a taken-back send.
    private func putBack(_ pending: PendingTakeBack, requestId: String, images: [MessageImage]) {
        let id = pending.conversationId
        guard let draft = pending.draft(for: id) else { return }
        drafts[id] = draft.text
        skillChips[id] = .restored(text: draft.text, skills: draft.skills)
        var tray = trays[id] ?? AttachmentTray()
        tray.restore(images)
        trays[id] = tray
        let known = sentFileDetails[requestId] ?? []
        restoreFiles(
            conversation: id,
            attachments: draft.attachments.compactMap { attachmentId in
                known.first { $0.id == attachmentId }
            }
        )
        sentFileDetails.removeValue(forKey: requestId)
        if case .conversation(id)? = navPath.last {
            queuedEditFocus[id, default: 0] += 1
        }
    }

    /// Withdraw a queued row without editing it. `sent` means it reached the
    /// transcript before the call landed; every other success is silent.
    func withdrawQueued(conversation id: UInt64, item: QueueItem) {
        guard connected, hostSupports("withdrawQueued"), let session,
              queuedEdit.copy?.id != item.id,
              queuePending.insert(item.id).inserted
        else { return }
        Task { [weak self] in
            defer { self?.queuePending.remove(item.id) }
            do {
                if try await session.withdrawQueued(submissionId: item.id, target: id) == .sent {
                    self?.showToast("Already sent, can't withdraw")
                }
            } catch {
                guard let self else { return }
                self.showToast(self.describe(error), level: "error")
            }
        }
    }

    /// Promote a queued follow-up to steer in place. `steered` only means
    /// the next available boundary will treat it as steer — it is not an
    /// "inserted now" notice; `sent` and `unavailable` are equally silent.
    func steerQueued(conversation id: UInt64, item: QueueItem) {
        guard connected, hostSupports("steerQueued"), let session,
              queuedEdit.copy?.id != item.id,
              queuePending.insert(item.id).inserted
        else { return }
        Task { [weak self] in
            defer { self?.queuePending.remove(item.id) }
            do {
                _ = try await session.steerQueued(submissionId: item.id, target: id)
            } catch {
                guard let self else { return }
                self.showToast(self.describe(error), level: "error")
            }
        }
    }

    /// Withdraw a queued row and, if the host still had it, put its text and
    /// images back. The content is read before the call because a successful
    /// withdrawal removes the row from the next snapshot.
    func editQueued(conversation id: UInt64, item: QueueItem) {
        guard connected, hostSupports("withdrawQueued"), let session,
              !queuedEditDisabled(conversation: id),
              queuedEdit.copy?.id != item.id,
              queuedEditPreparing.isEmpty,
              let input = session.queuedInput(submissionId: item.id)
        else { return }
        let copy = QueuedEdit.Copy(
            conversationId: id, id: item.id, text: input.text, images: input.images,
            skills: input.skills, attachments: input.attachments)
        // Refs are valid only while the row is still in the subscribed view;
        // resolve every image before withdrawing, or the copy could not be
        // resent after the row leaves the inbox (ADR-0027 §5).
        queuedEditPreparing.insert(id)
        queuePending.insert(item.id)
        Task { [weak self] in
            guard let self else { return }
            do {
                let resolved = try await copy.resolvingImages { ref, variant in
                    try await self.cachedImage(ref: ref, variant: variant)
                }
                // A host switch drops the prepared copy; never begin a
                // withdraw on the replaced session after the fetch lands.
                guard self.session === session, self.queuedEditPreparing.contains(id) else {
                    self.queuedEditPreparing.remove(id)
                    self.queuePending.remove(item.id)
                    return
                }
                guard self.queuedEdit.begin(resolved) else {
                    self.queuedEditPreparing.remove(id)
                    self.queuePending.remove(item.id)
                    return
                }
                self.queuedEditPreparing.remove(id)
                await self.resolveQueuedEdit(resolved, session: session)
            } catch {
                self.queuedEditPreparing.remove(id)
                self.queuePending.remove(item.id)
                self.showToast("Couldn't load an image for editing. Try again.", level: "error")
            }
        }
    }

    /// The reconnect retry trigger: only a copy whose withdraw reply was
    /// lost is pending, and the host's withdraw is idempotent.
    func retryQueuedEditIfNeeded() {
        guard let session, let copy = queuedEdit.retryOnReconnect(connected: connected) else { return }
        queuePending.insert(copy.id)
        Task { [weak self] in
            await self?.resolveQueuedEdit(copy, session: session)
        }
    }

    private func resolveQueuedEdit(_ copy: QueuedEdit.Copy, session: PinomadSession) async {
        do {
            let outcome = try await session.withdrawQueued(
                submissionId: copy.id, target: copy.conversationId)
            guard queuedEdit.copy == copy else { return }
            switch outcome {
            case .withdrawn:
                guard let restored = queuedEdit.withdrawn() else { return }
                queuePending.remove(copy.id)
                putBack(restored)
            case .sent:
                queuedEdit.alreadySent()
                queuePending.remove(copy.id)
                showToast("Already sent, can't withdraw")
            }
        } catch let error as SessionError {
            guard queuedEdit.copy == copy else { return }
            switch error {
            case .connectionLost:
                // The request's connection epoch ended: the host may have
                // withdrawn it, so keep the copy and re-confirm by id.
                await awaitReconnectOrRetry(copy)
            case .operationFailed:
                // A refusal from a replaced session does not describe this
                // input; ask the live one again when it is reachable.
                guard self.session === session else {
                    await awaitReconnectOrRetry(copy)
                    return
                }
                // The epoch did not move, so the host refused while the
                // connection stayed up: nothing was withdrawn.
                queuedEdit.failed(connected: true)
                queuePending.remove(copy.id)
                showToast(describe(error), level: "error")
            case .sessionClosed:
                await awaitReconnectOrRetry(copy)
            }
        } catch {
            // Not a session refusal: keep the copy for the reconnect retry
            // rather than guessing that the input was not withdrawn.
            guard queuedEdit.copy == copy else { return }
            await awaitReconnectOrRetry(copy)
        }
    }

    /// Resolve a copy whose old session can no longer answer. The core's
    /// live connection, not the published snapshot, gates the immediate
    /// retry — the snapshot can be stale in either direction. When it is not
    /// live, the copy waits for a connected view; every such view checks for
    /// a pending retry, so a coalesced disconnect edge cannot strand it.
    private func awaitReconnectOrRetry(_ copy: QueuedEdit.Copy) async {
        guard queuedEdit.copy == copy else { return }
        if let live = self.session, live.isConnectedNow {
            await resolveQueuedEdit(copy, session: live)
        } else {
            queuedEdit.failed(connected: false)
        }
    }

    private func putBack(_ copy: QueuedEdit.Copy) {
        drafts[copy.conversationId] = copy.text
        skillChips[copy.conversationId] = .restored(text: copy.text, skills: copy.skills)
        var tray = trays[copy.conversationId] ?? AttachmentTray()
        tray.restore(copy.images)
        trays[copy.conversationId] = tray
        restoreFiles(conversation: copy.conversationId, attachments: copy.attachments)
        transcriptPin += 1
        queuedEditFocus[copy.conversationId, default: 0] += 1
    }

    /// One ref and variant's bytes, from disk/memory or the host. The cache
    /// coalesces concurrent requests and retries failures; the session's
    /// ordered loop only carries the read-only `image` call.
    func cachedImage(ref: String, variant: ImageVariant = .original) async throws -> CachedImage {
        guard let session else { throw SessionError.sessionClosed }
        return try await cachedImage(ref: ref, variant: variant, session: session)
    }

    /// The same read pinned to a captured session: a host switch must not
    /// load the old conversation's ref through the new host.
    func cachedImage(
        ref: String, variant: ImageVariant = .original, session: PinomadSession
    ) async throws -> CachedImage {
        try await images.load(ref: ref, variant: variant) { ref, variant in
            let result = try await session.invoke(.image(ref: ref, variant: variant))
            guard case .image(let image) = result else {
                throw SessionError.operationFailed("The host's reply wasn't an image.")
            }
            return CachedImage(data: image.data, mimeType: image.mimeType, variant: image.variant)
        }
    }

    /// What AgentChatKit asks for when a ref image scrolls into view.
    func inlineImage(ref: String, variant: ImageVariant) async throws -> ToolImage {
        let image = try await cachedImage(ref: ref, variant: variant)
        return ToolImage(data: image.data, mimeType: image.mimeType, ref: ref)
    }

    var inlineImageLoader: InlineImageLoader {
        InlineImageLoader { [weak self] ref, purpose in
            guard let self else { throw SessionError.sessionClosed }
            let variant: ImageVariant
            switch purpose {
            case .userMessage: variant = .thumbnail
            case .toolResult: variant = .preview
            case .viewer: variant = .original
            }
            return try await self.inlineImage(ref: ref, variant: variant)
        }
    }

    private func run(_ call: FfiCall) {
        guard let session else { return }
        Task { _ = try? await session.invoke(call) }
    }
}
