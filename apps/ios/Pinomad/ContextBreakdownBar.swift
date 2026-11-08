import PinomadChat
import SwiftUI

extension ContextBreakdownReading.Part {
    /// The web's categorical data palette (`--pigui-data-*`), the same in
    /// both appearances: its lightness reads evenly on light and dark.
    var color: Color {
        switch self {
        case .system: Color(red: 0xB7 / 255, green: 0xBE / 255, blue: 0xC8 / 255)
        case .skills: Color(red: 0xF5 / 255, green: 0xB8 / 255, blue: 0x3D / 255)
        case .tools: Color(red: 0x0E / 255, green: 0xAB / 255, blue: 0x4E / 255)
        case .mcp: Color(red: 0xFF / 255, green: 0x6A / 255, blue: 0x2A / 255)
        case .messages: Color(red: 0x16 / 255, green: 0x77 / 255, blue: 0xE8 / 255)
        }
    }
}

/// What fills the context window as one stacked bar on the window's scale.
/// Decoration: the rows under it carry the figures for VoiceOver.
struct ContextBreakdownBar: View {
    let reading: ContextBreakdownReading

    var body: some View {
        GeometryReader { proxy in
            let gaps = CGFloat(max(0, reading.rows.count - 1))
            HStack(spacing: 1) {
                ForEach(reading.rows) { row in
                    row.part.color
                        .frame(width: max(0, (proxy.size.width - gaps) * row.fraction))
                }
                Spacer(minLength: 0)
            }
            .background(Color(uiColor: .tertiarySystemFill))
            .clipShape(Capsule())
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

/// A part's color key in its row, sized to sit in the ring's icon column.
struct ContextBreakdownSwatch: View {
    let part: ContextBreakdownReading.Part

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(part.color)
            .frame(width: 10, height: 10)
            .frame(width: 18, height: 18)
    }
}
