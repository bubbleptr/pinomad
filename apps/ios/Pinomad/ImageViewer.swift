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
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var drag: CGSize = .zero
    /// Where the last pan left the zoomed image; each new drag adds to it.
    @State private var settledDrag: CGSize = .zero

    private var displayed: ToolImage? {
        if !image.data.isEmpty {
            return ToolImage(data: image.data, mimeType: image.mimeType, ref: image.ref)
        }
        return fetched
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
                Image(.triangleAlert)
                    .font(.largeTitle)
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Couldn't load image")
            } else {
                ProgressView()
                    .tint(.white)
                    .accessibilityLabel("Loading image")
            }
        }
        .task(id: image.data.isEmpty ? image.ref.map { "\($0):\(epoch)" } : nil) {
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
        guard image.data.isEmpty, let ref = image.ref, !ref.isEmpty else {
            if image.data.isEmpty { failed = true }
            return
        }
        failed = false
        guard let loader else {
            failed = true
            return
        }
        do {
            let loaded = try await loader.image(for: ref)
            fetched = loaded
            failed = false
        } catch {
            failed = true
        }
    }
}
