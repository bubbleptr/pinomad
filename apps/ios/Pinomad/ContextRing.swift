import PinomadChat
import SwiftUI

/// The context gauge: a ring whose fill is the share of the window used,
/// orange once it nears compaction. An empty reading keeps the bare track,
/// so the row doesn't change shape between replies (or after a compaction).
struct ContextRing: View {
    let reading: ContextMeterReading

    private var tint: Color {
        Color(uiColor: reading.warning ? UIColor.systemOrange : UIColor.secondaryLabel)
    }

    var body: some View {
        ZStack {
            // A visible track at quarter opacity reads "gauge"; a faint
            // track plus a round cap reads "spinner" (the web's fix).
            Circle()
                .inset(by: 1)
                .stroke(tint.opacity(0.25), lineWidth: 2)
            Circle()
                .inset(by: 1)
                .trim(from: 0, to: reading.fill)
                .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .butt))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
    }
}
