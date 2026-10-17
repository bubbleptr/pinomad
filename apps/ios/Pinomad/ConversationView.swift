import AgentChatCore
import AgentChatKit
import PinomadChat
import PinomadCore
import SwiftUI

/// The shown conversation, read-only: entries render through AgentChatKit
/// — user bubbles, the run's trace, the answer's streaming markdown —
/// while `PinomadSession` keeps the snapshot current. Rows are equatable
/// keyed by the core's stable entry ids so a new version re-renders only
/// what actually changed.
struct ConversationView: View {
    let model: AppModel
    let conversationId: UInt64

    private var conversation: ConversationSnapshot? {
        model.snapshot?.conversation.flatMap { $0.id == conversationId ? $0 : nil }
    }

    private var title: String {
        guard let organized = model.snapshot?.organized,
              let node = findConversation(organized: organized, id: conversationId)
        else { return "对话" }
        return displayName(summary: node.summary)
    }

    var body: some View {
        Group {
            if let conversation {
                Transcript {
                    ForEach(conversation.chat, id: \.entryId) { entry in
                        row(entry)
                    }
                    if !conversation.statusText.isEmpty {
                        Text(conversation.statusText)
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }
            } else {
                ProgressView("正在载入对话…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { model.openConversation(conversationId) }
    }

    @ViewBuilder
    private func row(_ entry: ChatEntry) -> some View {
        switch entry {
        case let .user(_, text, images):
            UserRow(text: text, images: images).equatable()
        case let .run(_, cot, _, interrupted, failure):
            RunRow(cot: cot, interrupted: interrupted, failure: failure).equatable()
        case .compaction:
            MarkerRow("上下文已压缩")
        case .reset:
            MarkerRow("对话已重置")
        }
    }
}

/// What the user sent: the bubble, then any attached images.
private struct UserRow: View, Equatable {
    let text: String
    let images: [MessageImage]

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !text.isEmpty { UserMessageView(text) }
            ForEach(images, id: \.data) { image in
                InlineImage(ToolImage(data: image.data, mimeType: image.mimeType), maxWidth: 240, maxHeight: 200)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.images == rhs.images
    }
}

/// One run: the trace header/steps, the answer as it streams or settled,
/// and the failure line a dead run leaves behind.
private struct RunRow: View, Equatable {
    let cot: CotView
    let interrupted: Bool
    let failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentTraceView(ChatAdapter.trace(cot: cot, interrupted: interrupted))
            if let answer = cot.answer {
                ReplyBody(answer: answer)
            }
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
        }
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.cot == rhs.cot && lhs.interrupted == rhs.interrupted && lhs.failure == rhs.failure
    }
}

/// Snapshot-only markers between entries.
private struct MarkerRow: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
    }
}

/// A run's answer. The whole text arrives per snapshot — the stream owns
/// the reveal and only the new suffix is appended, so a settled answer is
/// parsed exactly once while a streaming one reveals at pace (the same
/// contract the kit's live thinking uses).
private struct ReplyBody: View {
    let answer: CotAnswer

    @State private var stream: StreamingMarkdown?
    @State private var finished = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let stream {
                StreamingMarkdownView(stream)
                if stream.stream.isFinished {
                    ReplyActions(markdown: stream.markdown)
                }
            }
        }
        .onAppear(perform: sync)
        .onChange(of: answer) { _, _ in sync() }
    }

    private func sync() {
        if stream == nil {
            let next = StreamingMarkdown(pace: answer.streaming ? .standard : nil)
            if !answer.text.isEmpty { next.append(answer.text) }
            stream = next
        } else if finished || !answer.text.hasPrefix(stream!.markdown) {
            // A rewrite or growth after finish: replaying stale content is
            // worse than showing the new text at once.
            let next = StreamingMarkdown(pace: nil)
            if !answer.text.isEmpty { next.append(answer.text) }
            stream = next
            finished = false
        } else {
            let delta = String(answer.text.dropFirst(stream!.markdown.count))
            if !delta.isEmpty { stream!.append(delta) }
        }
        if !answer.streaming, let stream, !finished {
            stream.finish()
            finished = true
        }
    }
}
