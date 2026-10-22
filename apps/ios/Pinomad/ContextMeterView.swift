import PinomadChat
import PinomadCore
import SwiftUI

/// The composer's context gauge: a small ring and the percent, opening a
/// popover with the exact figures. `nil` usage keeps the empty ring and an
/// em dash visible, so the meter doesn't appear and disappear between
/// replies (or after a compaction).
struct ContextMeterView: View {
    let usage: ContextUsage?

    @State private var showingDetail = false

    private var reading: ContextMeterReading { ContextMeterReading(usage) }

    /// Concrete colors: on glass the hierarchical styles pick up vibrancy
    /// and read as disabled grey.
    private var tint: Color {
        Color(uiColor: reading.warning ? UIColor.systemOrange : UIColor.secondaryLabel)
    }

    var body: some View {
        Button {
            showingDetail = true
        } label: {
            HStack(spacing: 5) {
                ring
                Text(reading.text)
                    .font(.footnote.monospacedDigit())
            }
            .foregroundStyle(tint)
            .frame(height: 34)
            // A 44pt touch target without growing the 34pt tool row: the
            // negative padding gives the extra height back to the layout.
            .padding(.vertical, 5)
            .contentShape(.rect)
        }
        .buttonStyle(.press)
        .padding(.vertical, -5)
        // The meter keeps its width; a long model name truncates first.
        .fixedSize()
        .accessibilityLabel(reading.accessibilityLabel)
        .accessibilityHint("Shows usage details")
        .popover(isPresented: $showingDetail, arrowEdge: .bottom) {
            Text(reading.detail)
                .font(.footnote.monospacedDigit())
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .presentationCompactAdaptation(.popover)
        }
    }

    private var ring: some View {
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
        .frame(width: 16, height: 16)
    }
}
