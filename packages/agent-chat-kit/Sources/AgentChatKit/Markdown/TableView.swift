import AgentChatCore
import SwiftUI

struct TableView: View {
    let table: MarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, inline in
                        cellText(inline, column: column).fontWeight(.semibold)
                    }
                }
                Divider()
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, inline in
                            cellText(inline, column: column)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func cellText(_ inline: MarkdownInline, column: Int) -> some View {
        SwiftUI.Text(InlineText.attributed(inline))
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
