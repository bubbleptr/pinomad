import AgentChatCore
import AgentChatKit
import Foundation
import PinomadCore

/// One `StreamingMarkdown` per run with an answer, keyed by the run's
/// stable entry id. Owned outside the view tree: creating or mutating
/// these from a lazy row's `onAppear`/`onChange` kept the iOS 27 layout
/// unsettled (the transcript rendered blank), so snapshots feed them here
/// instead and rows stay side-effect free.
///
/// The snapshot always carries each answer's whole text; a stream only
/// gets the arrived suffix appended, while a rewrite (non-prefix update)
/// or growth past `finish()` restarts it. Runs that leave the shown
/// conversation — a switch away — are evicted rather than kept alive.
@MainActor @Observable
public final class ReplyStreams {
    public private(set) var byRunId: [String: StreamingMarkdown] = [:]

    public init() {}

    /// The stream a run's answer reveals through; nil while the run has
    /// produced no answer text at all.
    public func stream(for entryId: String) -> StreamingMarkdown? {
        byRunId[entryId]
    }

    /// Feed the shown conversation's chat into the streams. Called once
    /// per published snapshot, before the UI reads it.
    public func sync(chat: [ChatEntry]?) {
        var live: [String: StreamingMarkdown] = [:]
        for entry in chat ?? [] {
            guard case let .run(id, cot, _, _, _, _) = entry,
                  let answer = cot.answer, !answer.text.isEmpty else { continue }
            live[id] = feed(id: id, answer: answer, current: byRunId[id])
        }
        byRunId = live
    }

    private func feed(id: String, answer: CotAnswer, current: StreamingMarkdown?) -> StreamingMarkdown {
        guard let stream = current else {
            let fresh = StreamingMarkdown(pace: answer.streaming ? .standard : nil)
            fresh.append(answer.text)
            if !answer.streaming { fresh.finish() }
            return fresh
        }
        if answer.text.hasPrefix(stream.markdown) {
            let delta = String(answer.text.dropFirst(stream.markdown.count))
            if !delta.isEmpty {
                if stream.stream.isFinished {
                    // A finished stream may still see a rewritten tail —
                    // start over rather than trip append-after-finish.
                    return feed(id: id, answer: answer, current: nil)
                }
                stream.append(delta)
            }
            if !answer.streaming { stream.finish() }
            return stream
        }
        return feed(id: id, answer: answer, current: nil)
    }
}
