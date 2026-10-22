import AgentChatCore
import SwiftUI

/// Actions under a finished reply. Copy takes the reply as plain text; held,
/// it offers the Markdown source too.
public struct ReplyActions: View {
    let markdown: String
    @State private var copied = false

    public init(markdown: String) {
        self.markdown = markdown
    }

    public var body: some View {
        HStack(spacing: 4) {
            Menu {
                Button {
                    copy(markdown)
                } label: {
                    Label { Text("Copy as Markdown", bundle: .module) } icon: { Image(Icon.code) }
                }
            } label: {
                Image(copied ? Icon.check : .copy)
                    .contentTransition(.symbolEffect(.replace))
                    .font(.footnote)
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            } primaryAction: {
                copy(PlainText.of(markdown: markdown))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel(copied ? Text("Copied", bundle: .module) : Text("Copy", bundle: .module))
        }
        .padding(.leading, -8)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }

    private func copy(_ text: String) {
        Pasteboard.copy(text)
        copied = true
    }
}
