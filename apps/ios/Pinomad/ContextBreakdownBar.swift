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

/// The context gauge: a bar on the window's scale. With the host's breakdown
/// it stacks one segment per part; without one (an older host, or the reply
/// not broken down yet) it is a single fill, orange once it nears compaction —
/// so a breakdown arriving only colours the bar in, the row never changes
/// shape. Unknown usage keeps the bare track. Decoration for VoiceOver: the
/// row reads the meter's label and the part rows carry their figures.
struct ContextBar: View {
    let meter: ContextMeterReading
    let breakdown: ContextBreakdownReading?

    private var segments: [(id: String, color: Color, fraction: Double)] {
        if let breakdown {
            return breakdown.rows.map { (id: $0.part.rawValue, color: $0.part.color, fraction: $0.fraction) }
        }
        let tint = Color(uiColor: meter.warning ? .systemOrange : .secondaryLabel)
        return [(id: "used", color: tint, fraction: meter.fill)]
    }

    var body: some View {
        GeometryReader { proxy in
            let segments = self.segments
            let gaps = CGFloat(max(0, segments.count - 1))
            HStack(spacing: 1) {
                ForEach(segments, id: \.id) { segment in
                    segment.color
                        .frame(width: max(0, (proxy.size.width - gaps) * segment.fraction))
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

/// A part's color key in its row.
struct ContextBreakdownSwatch: View {
    let part: ContextBreakdownReading.Part

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(part.color)
            .frame(width: 10, height: 10)
    }
}
