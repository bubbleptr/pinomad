import PinomadChat
import SwiftUI

extension ContextBreakdownReading.Part {
    /// The web's palette (`--palette-*` in `tokens.css`), light and dark.
    /// The fixed overhead the host sends every request is one blue family,
    /// darkest first: `--palette-blue`, then its 60% and 30% steps toward white,
    /// mixed in oklab. MCP, the part servers add, is `--palette-teal`; messages,
    /// the part that grows, `--palette-purple`.
    var color: Color {
        switch self {
        case .system: Color(light: 0x0190FE, dark: 0x4FB0FE)
        case .tools: Color(light: 0x82BFFF, dark: 0x9BD1FF)
        case .skills: Color(light: 0xC1E0FF, dark: 0xCEE8FF)
        case .mcp: Color(light: 0x13B3A0, dark: 0x4FC3B4)
        case .messages: Color(light: 0xA651F0, dark: 0xB98AF0)
        }
    }
}

private extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat(hex >> 16 & 0xFF) / 255,
                green: CGFloat(hex >> 8 & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

/// The context meter: a grid of cells on the window's scale. With the host's
/// breakdown it colours the cells one part after another; without one (an
/// older host, or the reply not broken down yet) it is a single fill, orange
/// once it nears compaction — so a breakdown arriving only colours the cells
/// in. Unknown usage leaves every cell empty. Decoration for VoiceOver: the
/// row reads the meter's label and the legend rows carry their figures.
struct ContextGrid: View {
    /// What is left of the window: the empty cells, and the Left row's swatch.
    static let emptyColor = Color(uiColor: .tertiarySystemFill)

    let meter: ContextMeterReading
    let breakdown: ContextBreakdownReading

    private func color(at index: Int) -> Color {
        guard index < breakdown.cells.count else { return Self.emptyColor }
        switch breakdown.cells[index] {
        case .used: return Color(uiColor: meter.warning ? .systemOrange : .secondaryLabel)
        case .part(let part): return part.color
        }
    }

    var body: some View {
        let columns = ContextBreakdownReading.columns
        VStack(spacing: 2) {
            ForEach(0..<ContextBreakdownReading.cellCount / columns, id: \.self) { row in
                HStack(spacing: 2) {
                    ForEach(0..<columns, id: \.self) { column in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(color(at: row * columns + column))
                            .aspectRatio(1, contentMode: .fit)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// A legend row's color key.
struct ContextBreakdownSwatch: View {
    let color: Color

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(color)
            .frame(width: 10, height: 10)
    }
}
