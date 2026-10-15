import Markdown
import SwiftUI

struct TableView: View {
    let table: Markdown.Table

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(table.head.cells.enumerated()), id: \.offset) { column, cell in
                        cellText(cell, column: column).fontWeight(.semibold)
                    }
                }
                Divider()
                ForEach(Array(table.body.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.cells.enumerated()), id: \.offset) { column, cell in
                            cellText(cell, column: column)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func cellText(_ cell: Markdown.Table.Cell, column: Int) -> some View {
        SwiftUI.Text(InlineText.attributed(cell))
            .gridColumnAlignment(alignment(of: column))
    }

    private func alignment(of column: Int) -> HorizontalAlignment {
        guard column < table.columnAlignments.count else { return .leading }
        switch table.columnAlignments[column] {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }
}
