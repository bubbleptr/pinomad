import AgentChatCore
import SwiftUI

struct CodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                SwiftUI.Text(language?.isEmpty == false ? language! : String(localized: "code", bundle: .module))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                CopyButton(text: code)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            ScrollView(.horizontal, showsIndicators: false) {
                SwiftUI.Text(highlighted)
                    .font(.callout.monospaced())
                    .fadingTail()
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .background(.fill.quaternary, in: .rect(cornerRadius: 12))
    }

    private var highlighted: AttributedString {
        let text = code.hasSuffix("\n") ? String(code.dropLast()) : code
        var attributed = AttributedString(text)
        for token in CodeHighlighter.tokens(in: text, language: language) {
            guard let range = Range(token.range, in: attributed) else { continue }
            attributed[range].foregroundColor = Self.color(of: token.kind)
        }
        return attributed
    }

    // System colors, so the palette follows light and dark mode on its own.
    private static func color(of kind: CodeToken.Kind) -> Color {
        switch kind {
        case .keyword: .purple
        case .string: .red
        case .comment, .meta: .secondary
        case .number: .blue
        case .type: .teal
        case .key: .indigo
        case .inserted: .green
        case .deleted: .red
        }
    }
}

struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            Pasteboard.copy(text)
            copied = true
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .contentTransition(.symbolEffect(.replace))
                .font(.caption)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel(copied ? Text("Copied", bundle: .module) : Text("Copy code", bundle: .module))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}
