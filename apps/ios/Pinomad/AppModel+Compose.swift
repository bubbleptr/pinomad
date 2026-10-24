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
    /// Send the conversation's draft. Idle → a plain prompt; busy → `mode`
    /// decides between steering the run and queueing a follow-up. The
    /// draft clears at once and comes back if the session was gone.
    func send(conversation id: UInt64, mode: SubmitMode) {
        let text = drafts[id] ?? ""
        let tray = trays[id] ?? AttachmentTray()
        let files = fileTrays[id] ?? FileAttachmentTray()
        guard !text.allSatisfy(\.isWhitespace) || !tray.images.isEmpty || !files.isEmpty,
              tray.preparing == 0, files.canSend, let session else { return }
        let images = tray.images
        let attachments = files.ids
        let chips = chips(for: id)
        let payload = chips.payload(hostMinor: hostMinor)
        drafts[id] = ""
        skillChips[id] = nil
        trays[id] = nil
        fileTrays[id] = nil
        transcriptPin += 1
        Task { [weak self] in
            do {
                _ = try await session.invoke(
                    .submit(text: payload.text, whenBusy: mode, target: id, requestId: nil,
                            images: images, skills: payload.skills, attachments: attachments))
            } catch {
                guard let self else { return }
                // Don't clobber anything typed or attached meanwhile.
                if (self.drafts[id] ?? "").isEmpty {
                    self.drafts[id] = text
                    self.skillChips[id] = chips
                }
                if self.trays[id]?.isEmpty ?? true {
                    var restored = AttachmentTray()
                    if let claim = restored.reserve(images.count, accepts: true) {
                        restored.fulfil(claim, with: images)
                    }
                    self.trays[id] = restored
                }
                if self.fileTrays[id] == nil, !files.isEmpty {
                    self.fileTrays[id] = files
                }
                self.lastError = "Couldn't send: \(self.describe(error))"
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
    }

    /// Editing restores the queued input over the composer, so it waits for
    /// an empty composer and for the previous Edit to resolve.
    func queuedEditDisabled(conversation id: UInt64) -> Bool {
        guard queuedEdit.canBegin, queuedEditPreparing.isEmpty else { return true }
        let text = drafts[id] ?? ""
        let tray = trays[id] ?? AttachmentTray()
        let files = fileTrays[id] ?? FileAttachmentTray()
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !tray.images.isEmpty || tray.preparing > 0 || !files.isEmpty
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
                let resolved = try await copy.resolvingImages { ref in
                    try await self.cachedImage(ref: ref)
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

    /// One ref's bytes, from disk/memory or the host. The cache coalesces
    /// concurrent requests and retries failures; the session's ordered loop
    /// only carries the read-only `image` call.
    func cachedImage(ref: String) async throws -> CachedImage {
        guard let session else { throw SessionError.sessionClosed }
        return try await images.load(ref: ref) { ref in
            let result = try await session.invoke(.image(ref: ref))
            guard case .image(let image) = result else {
                throw SessionError.operationFailed("The host's reply wasn't an image.")
            }
            return CachedImage(data: image.data, mimeType: image.mimeType)
        }
    }

    /// What AgentChatKit asks for when a ref image scrolls into view.
    func inlineImage(ref: String) async throws -> ToolImage {
        let image = try await cachedImage(ref: ref)
        return ToolImage(data: image.data, mimeType: image.mimeType, ref: ref)
    }

    var inlineImageLoader: InlineImageLoader {
        InlineImageLoader { [weak self] ref in
            guard let self else { throw SessionError.sessionClosed }
            return try await self.inlineImage(ref: ref)
        }
    }

    private func run(_ call: FfiCall) {
        guard let session else { return }
        Task { _ = try? await session.invoke(call) }
    }
}
