import AgentChatCore
import SwiftUI

/// A todo item's status as one ring: hollow while it waits, cut into
/// slowly turning dashes while it is worked on, a filled disc whose check
/// draws in once it is done. The dashes tell it from the waiting ring by
/// shape alone, so it still reads with motion reduced. Drawn rather than a symbol so one state can animate into the
/// next; a hidden `circle` icon gives it a symbol's size and baseline, so
/// it scales with the font and lines up with the item's text.
struct TodoStatusMark: View {
    let status: TodoList.Status
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(Icon.circle)
            .hidden()
            .overlay {
                GeometryReader { proxy in
                    let diameter = min(proxy.size.width, proxy.size.height)
                    ring(lineWidth: diameter / 11)
                        .frame(width: diameter, height: diameter)
                        .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
                }
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: status)
            .accessibilityElement()
            .accessibilityLabel(label)
    }

    // Lucide's ring: a 2px stroke on a 22px circle.
    private func ring(lineWidth: CGFloat) -> some View {
        ZStack {
            Circle()
                .inset(by: lineWidth / 2)
                .stroke(.tertiary, lineWidth: lineWidth)
                .opacity(status == .pending ? 1 : 0)
            if status == .inProgress {
                TurningDashes(lineWidth: lineWidth, turning: !reduceMotion)
                    .transition(.opacity)
            }
            Disc(lineWidth: lineWidth, checked: status == .completed)
                .opacity(status == .completed ? 1 : 0)
                .scaleEffect(status == .completed ? 1 : 0.6)
        }
    }

    private var label: String {
        switch status {
        case .completed: String(localized: "Done", bundle: .module)
        case .inProgress: String(localized: "In progress", bundle: .module)
        case .pending: String(localized: "Not done", bundle: .module)
        }
    }
}

/// The ring cut into eight dashes in the tint, going round once every 8
/// seconds — slow enough to say "being worked on" rather than "loading".
/// Round caps reach half a line width past each dash's ends, so the gaps
/// are cut wider by that much.
private struct TurningDashes: View {
    let lineWidth: CGFloat
    let turning: Bool

    var body: some View {
        TimelineView(.animation(paused: !turning)) { context in
            let turns = turning ? context.date.timeIntervalSinceReferenceDate / 8 : 0
            GeometryReader { proxy in
                let diameter = min(proxy.size.width, proxy.size.height) - lineWidth
                let segment = .pi * diameter / 8
                let gap = lineWidth * 2.2
                Circle()
                    .inset(by: lineWidth / 2)
                    .stroke(.tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, dash: [segment - gap, gap]))
            }
            .rotationEffect(.degrees(turns.truncatingRemainder(dividingBy: 1) * 360))
        }
    }
}

/// The done disc. The check takes the background's color, not white, so
/// it reads on the light grey disc of dark mode as well. Concrete colors:
/// on glass, hierarchical styles get vibrancy and wash
/// the check into the disc (and a cut-out shows the vibrancy, not the
/// background). It draws in only on the change to done; a list opened with
/// items already done shows their checks whole.
private struct Disc: View {
    let lineWidth: CGFloat
    let checked: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle().fill(Color.secondaryLabel)
            Check()
                .trim(from: 0, to: checked ? 1 : 0)
                .stroke(Color.systemBackground, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                .animation(reduceMotion ? nil : .smooth(duration: 0.3).delay(0.12), value: checked)
        }
    }
}

private extension Color {
    #if canImport(UIKit)
    static let secondaryLabel = Color(uiColor: .secondaryLabel)
    static let systemBackground = Color(uiColor: .systemBackground)
    #else
    static let secondaryLabel = Color(nsColor: .secondaryLabelColor)
    static let systemBackground = Color(nsColor: .windowBackgroundColor)
    #endif
}

private struct Check: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.29, y: rect.minY + rect.height * 0.52))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.44, y: rect.minY + rect.height * 0.66))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.71, y: rect.minY + rect.height * 0.37))
        return path
    }
}
