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
        guard !text.allSatisfy(\.isWhitespace) || !tray.images.isEmpty,
              tray.preparing == 0, let session else { return }
        let images = tray.images
        drafts[id] = ""
        trays[id] = nil
        transcriptPin += 1
        Task { [weak self] in
            do {
                _ = try await session.invoke(
                    .submit(text: text, whenBusy: mode, target: id, requestId: nil, images: images))
            } catch {
                guard let self else { return }
                // Don't clobber anything typed or attached meanwhile.
                if (self.drafts[id] ?? "").isEmpty { self.drafts[id] = text }
                if self.trays[id]?.isEmpty ?? true {
                    var restored = AttachmentTray()
                    if let claim = restored.reserve(images.count, accepts: true) {
                        restored.fulfil(claim, with: images)
                    }
                    self.trays[id] = restored
                }
                self.lastError = "发送失败：\(error.localizedDescription)"
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
                self?.trays[id]?.fulfil(claim, with: prepared)
            } catch {
                self?.trays[id]?.fail(claim, message: (error as? ImagePrep.Failure)?.description ?? "无法读取图片")
            }
        }
    }

    /// Stage the clipboard's image, or say there isn't one.
    func pasteImage(into id: UInt64, accepts: Bool) {
        // `hasImages` doesn't trigger the paste prompt; reading does.
        guard UIPasteboard.general.hasImages,
              let data = UIPasteboard.general.image?.jpegData(compressionQuality: 1)
        else {
            reportAttachProblem(conversation: id, "剪贴板里没有图片")
            return
        }
        attach(conversation: id, accepts: accepts, sources: [{ @Sendable in data }])
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
    /// until then so a refused answer (toasted) can be resent.
    func answer(_ question: PendingQuestion, conversation id: UInt64) {
        let draft = questionDrafts[question.request.id]
            ?? QuestionDraft(questionCount: question.request.questions.count)
        run(.answer(kind: question.kind, requestId: question.request.id,
                    answers: draft.answers(), target: id))
    }

    /// Resend a failed run's prompt. The request id is derived from the run,
    /// so a double tap or another client's retry is admitted once.
    func retry(_ request: RetryRequest, conversation id: UInt64) {
        transcriptPin += 1
        run(.submit(text: request.text, whenBusy: .followUp, target: id,
                    requestId: request.requestId, images: request.images))
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

    private func run(_ call: FfiCall) {
        guard let session else { return }
        Task { _ = try? await session.invoke(call) }
    }
}
