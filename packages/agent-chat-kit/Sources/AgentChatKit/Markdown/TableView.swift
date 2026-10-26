import AgentChatCore
import SwiftUI

struct TableView: View {
    let table: MarkdownTable
    @Environment(\.font) private var font
    @Environment(\.fontResolutionContext) private var fontContext

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, inline in
                        cellText(inline, column: column, header: true).fontWeight(.semibold)
                    }
                }
                Divider()
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, inline in
                            cellText(inline, column: column, header: false)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func cellText(_ inline: MarkdownInline, column: Int, header: Bool) -> some View {
        let base = font ?? .body
        return InlineText.text(inline, font: (header ? base.weight(.semibold) : base).resolve(in: fontContext))
            .gridColumnAlignment(alignment(of: column))
    }

    private func alignment(of column: Int) -> HorizontalAlignment {
        guard column < table.alignments.count else { return .leading }
        switch table.alignments[column] {
        case .center: return .center
        case .trailing: return .trailing
        case .leading: return .leading
        }
    }
}
