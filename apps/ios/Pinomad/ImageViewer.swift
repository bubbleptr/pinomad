import AgentChatCore
import AgentChatKit
import PinomadCore
import SwiftUI

/// One image full screen: pinch to zoom, tap or swipe down to close.
struct ImageViewer: View {
    let image: MessageImage
    let close: () -> Void

    @Environment(\.inlineImageLoader) private var loader
    @Environment(\.inlineImageEpoch) private var epoch
    @State private var fetched: ToolImage?
    @State private var failed = false
    @State private var attempt = 0
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var drag: CGSize = .zero
    /// Where the last pan left the zoomed image; each new drag adds to it.
    @State private var settledDrag: CGSize = .zero

    private var displayed: ToolImage? {
        if let fetched { return fetched }
        guard !image.data.isEmpty else { return nil }
        return ToolImage(data: image.data, mimeType: image.mimeType, ref: image.ref)
    }

    private var ref: String? {
        guard let ref = image.ref, !ref.isEmpty else { return nil }
        return ref
    }

    private func recentre() {
        drag = .zero
        settledDrag = .zero
    }

    var body: some View {
        ZStack {
            Color.black
                .opacity(1 - min(abs(drag.height) / 400, 0.6))
                .ignoresSafeArea()
            if let shown = displayed,
               let decoded = InlineImage.decoded(shown) {
                decoded
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .offset(drag)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { scale = max(1, settledScale * $0.magnification) }
                            .onEnded { _ in
                                settledScale = scale
                                // Back at fit: recentre, so the next drag is a
                                // dismiss pull from the middle.
                                if scale <= 1 { withAnimation(.snappy) { recentre() } }
                            }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                // Zoomed in, a drag pans on from where the last
                                // one stopped; at fit it's a dismiss pull.
                                drag = CGSize(width: settledDrag.width + value.translation.width,
                                              height: settledDrag.height + value.translation.height)
                            }
                            .onEnded { value in
                                if scale > 1 {
                                    settledDrag = drag
                                } else if abs(value.translation.height) > 80 || abs(value.predictedEndTranslation.height) > 300 {
                                    close()
                                } else {
                                    withAnimation(.snappy) { drag = .zero }
                                }
                            }
                    )
            } else if failed {
                VStack(spacing: 12) {
                    Image(.triangleAlert)
                        .font(.largeTitle)
                        .foregroundStyle(.tertiary)
                    Text("Couldn't load image")
                    if ref != nil {
                        Button("Try again") { attempt += 1 }
                            .buttonStyle(.bordered)
                    }
                }
                .accessibilityLabel("Couldn't load image")
            } else {
                ProgressView()
                    .tint(.white)
                    .accessibilityLabel("Loading image")
            }
        }
        .task(id: ref.map { "\($0):\(epoch):\(attempt)" }) {
            await fetchIfNeeded()
        }
        .contentShape(.rect)
        .onTapGesture(count: 2) {
            withAnimation(.snappy) {
                scale = scale > 1 ? 1 : 2.5
                settledScale = scale
                recentre()
            }
        }
        .onTapGesture { close() }
        .accessibilityAction(.escape) { close() }
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel("Image")
    }

    private func fetchIfNeeded() async {
        guard let ref else {
            if image.data.isEmpty { failed = true }
            return
        }
        failed = false
        guard let loader else {
            failed = true
            return
        }
        do {
            let loaded = try await loader.image(for: ref, purpose: .viewer)
            fetched = loaded
            failed = false
        } catch {
            failed = true
        }
    }
}
