import AgentChatCore
import SwiftUI

/// One tool call: its name and what it was given on a line, the call's
/// input and output when tapped.
struct ToolCallRow: View {
    let call: ToolCall
    @State private var isExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    status
                        .frame(width: 16)
                    Text(call.name)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(call.state == .failed ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                    if let preview {
                        Text(preview)
                            .font(.callout.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                    if let duration = call.duration, call.state == .succeeded || call.state == .failed {
                        Text(duration.formatted(.units(allowed: [.minutes, .seconds, .milliseconds], width: .narrow, maximumUnitCount: 1)))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(call.name), \(stateLabel)")

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    if let input = call.input, !input.isEmpty { DetailBox(text: input) }
                    if let output = call.output, !output.isEmpty { DetailBox(text: output) }
                    ForEach(call.children) { ToolCallRow(call: $0) }
                }
                .padding(.leading, 24)
                .transition(.opacity)
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch call.state {
        case .streamingInput, .running:
            ProgressView().controlSize(.mini)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        case .succeeded:
            Image(systemName: ToolSymbol.name(for: call.name))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// The input on one line: the part a reader recognizes the call by.
    private var preview: String? {
        guard let input = call.input?.trimmingCharacters(in: .whitespacesAndNewlines), !input.isEmpty else { return nil }
        return input.split(separator: "\n", maxSplits: 1).first.map(String.init)
    }

    private var stateLabel: String {
        switch call.state {
        case .streamingInput: "preparing"
        case .running: "running"
        case .succeeded: "done"
        case .failed: "failed"
        }
    }
}

private struct DetailBox: View {
    let text: String

    var body: some View {
        ScrollView([.horizontal, .vertical], showsIndicators: false) {
            Text(text)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: 180)
        .fixedSize(horizontal: false, vertical: true)
        .background(.fill.quaternary, in: .rect(cornerRadius: 10))
    }
}

/// A symbol for common tool names; anything else gets a generic one.
enum ToolSymbol {
    static func name(for tool: String) -> String {
        let name = tool.lowercased()
        if name.contains("bash") || name.contains("shell") || name.contains("exec") || name.contains("terminal") { return "terminal" }
        if name.contains("edit") || name.contains("write") || name.contains("patch") { return "pencil" }
        if name.contains("read") || name.contains("view") || name.contains("open") { return "doc.text" }
        if name.contains("grep") || name.contains("search") || name.contains("find") || name.contains("glob") { return "magnifyingglass" }
        if name.contains("fetch") || name.contains("web") || name.contains("browse") { return "globe" }
        if name.contains("agent") { return "person.2" }
        return "wrench.and.screwdriver"
    }
}
