import Foundation
import PinomadChat
import PinomadCore

/// The composer's calls. All command-class: a host refusal resolves
/// normally and surfaces as a notice toast, so only a dead session
/// (thrown) needs handling here.
extension AppModel {
    /// Send the conversation's draft. Idle → a plain prompt; busy → `mode`
    /// decides between steering the run and queueing a follow-up. The
    /// draft clears at once and comes back if the session was gone.
    func send(conversation id: UInt64, mode: SubmitMode) {
        let text = drafts[id] ?? ""
        guard !text.allSatisfy(\.isWhitespace), let session else { return }
        drafts[id] = ""
        transcriptPin += 1
        Task { [weak self] in
            do {
                _ = try await session.invoke(
                    .submit(text: text, whenBusy: mode, target: id, requestId: nil, images: []))
            } catch {
                guard let self else { return }
                // Don't clobber anything typed meanwhile.
                if (self.drafts[id] ?? "").isEmpty { self.drafts[id] = text }
                self.lastError = "发送失败：\(error.localizedDescription)"
            }
        }
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
