import SwiftUI

/// Grey shapes in the layout of content on its way, read out as `label`.
/// One clock drives every bone; each bone sweeps on its own rhythm so the
/// page breathes instead of blinking in unison. Still under Reduce Motion.
struct Skeleton<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                content
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    content.environment(\.skeletonClock, timeline.date.timeIntervalSinceReferenceDate)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// One placeholder bar. Without a width it fills the row.
struct Bone: View {
    var width: CGFloat?
    var height: CGFloat = 12
    var cornerRadius: CGFloat?

    @Environment(\.skeletonClock) private var clock
    /// Drawn once per bone and kept across renders.
    @State private var period = Double.random(in: 1.3...1.7)
    @State private var phase = Double.random(in: 0..<1)

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius ?? height / 2, style: .continuous)
        shape
            .fill(.fill.tertiary)
            .overlay {
                if let clock {
                    let t = (clock / period + phase).truncatingRemainder(dividingBy: 1)
                    // Smoothstep: the light lingers at the ends, crosses fast.
                    let x = t * t * (3 - 2 * t) * 2 - 1
                    LinearGradient(
                        colors: [.clear, .primary.opacity(0.08), .clear],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .visualEffect { content, proxy in
                        content.offset(x: x * proxy.size.width)
                    }
                }
            }
            .clipShape(shape)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

extension EnvironmentValues {
    /// The skeleton's clock in seconds; nil leaves the bones still.
    @Entry var skeletonClock: TimeInterval?
}

/// The home page while the app starts or connects: the four status tiles
/// and a machine's group rows.
struct HomeSkeleton: View {
    var body: some View {
        Skeleton(label: "正在载入") {
            VStack(alignment: .leading, spacing: 24) {
                Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                    GridRow { tile; tile }
                    GridRow { tile; tile }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Bone(width: 140, height: 20, cornerRadius: 6)
                        .padding(.bottom, 8)
                    GroupRowsSkeleton.rows
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        // The list's own background, so its arrival doesn't flash.
        .background(Color(.systemGroupedBackground))
    }

    private var tile: some View {
        Bone(height: 104, cornerRadius: 22)
    }
}

/// A machine's Chats and project rows while its first snapshot is on its
/// way — the shape of `groupRow`: icon, name, count.
struct GroupRowsSkeleton: View {
    var body: some View {
        Skeleton(label: "正在同步") { Self.rows }
    }

    static var rows: some View {
        VStack(spacing: 0) {
            ForEach([120, 168, 96] as [CGFloat], id: \.self) { width in
                HStack(spacing: 12) {
                    Bone(width: 24, height: 24, cornerRadius: 6)
                        .frame(width: 28)
                    Bone(width: width, height: 14)
                    Spacer()
                    Bone(width: 18, height: 14)
                }
                .padding(.vertical, 14)
            }
        }
    }
}

/// A conversation while its first view is on its way: a sent message and
/// the run's reply, in the transcript's spacing, settled at the bottom
/// where the transcript opens.
struct ConversationSkeleton: View {
    var body: some View {
        Skeleton(label: "正在载入对话") {
            VStack(alignment: .leading, spacing: 24) {
                bubble(width: 200)
                reply(lines: [nil, nil, 220])
                bubble(width: 150)
                reply(lines: [nil, nil, nil, 160])
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
    }

    private func bubble(width: CGFloat) -> some View {
        Bone(width: width, height: 40, cornerRadius: 18)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    /// The trace capsule, then the answer's lines.
    private func reply(lines: [CGFloat?]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Bone(width: 128, height: 28)
                .padding(.bottom, 4)
            ForEach(Array(lines.enumerated()), id: \.offset) { _, width in
                Bone(width: width, height: 12)
            }
        }
    }
}
