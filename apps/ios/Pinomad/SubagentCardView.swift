import PinomadChat
import SwiftUI

/// One delegated task in the transcript, mirroring the web's subagent card:
/// status and label on the first line, muted role/model/time on the second.
/// The role is only present when the call named an agent.
///
/// The card opens the child conversation once the call has recorded one;
/// the result disclosure stays a separate button so it never navigates.
struct SubagentCardView: View {
    let card: SubagentCard
    /// Pushes the child conversation. Nil leaves the card inert.
    let onOpen: ((UInt64) -> Void)?

    @State private var showingOutput = false

    init(card: SubagentCard, onOpen: ((UInt64) -> Void)? = nil) {
        self.card = card
        self.onOpen = onOpen
    }

    private var statusText: String {
        switch card.status {
        case .running: "运行中"
        case .done: "完成"
        case .failed: "失败"
        }
    }

    private var statusStyle: AnyShapeStyle {
        switch card.status {
        case .running: AnyShapeStyle(.green)
        case .done: AnyShapeStyle(.tertiary)
        case .failed: AnyShapeStyle(.red)
        }
    }

    private var meta: String {
        ([statusText] + card.meta).joined(separator: " · ")
    }

    /// A target only exists when the call recorded a child and the view has
    /// somewhere to push it.
    private var target: UInt64? {
        onOpen == nil ? nil : card.conversationId
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let target, let onOpen {
                Button {
                    onOpen(target)
                } label: {
                    summary
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(card.title)，\(statusText)")
                .accessibilityHint("打开子代理对话")
            } else {
                summary
            }
            if let output = card.output, !output.isEmpty {
                Button(showingOutput ? "收起结果" : "查看结果") {
                    showingOutput.toggle()
                }
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                if showingOutput {
                    ScrollView([.horizontal, .vertical], showsIndicators: false) {
                        Text(output)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)
                    .padding(10)
                    .background(.fill.quaternary, in: .rect(cornerRadius: 8))
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 12))
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(statusStyle)
                    .frame(width: 7, height: 7)
                Text(card.title)
                    .font(.callout)
                    .lineLimit(2)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                if target != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            // Same secondary style as the transcript's other captions; one
            // line keeps a long agent name from widening the card.
            Text(meta)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }
}
