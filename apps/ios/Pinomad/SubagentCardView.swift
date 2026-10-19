import PinomadChat
import SwiftUI

/// One delegated task in the transcript, mirroring the web's subagent card:
/// status and label on the first line, muted role/model/time on the second.
/// The role is only present when the call named an agent.
struct SubagentCardView: View {
    let card: SubagentCard

    @State private var showingOutput = false

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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(statusStyle)
                    .frame(width: 7, height: 7)
                Text(card.title)
                    .font(.callout)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
            // Same secondary style as the transcript's other captions; one
            // line keeps a long agent name from widening the card.
            Text(meta)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
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
}
