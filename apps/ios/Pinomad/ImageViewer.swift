import AgentChatCore
import AgentChatKit
import PinomadCore
import SwiftUI

/// One image full screen: pinch to zoom, tap or swipe down to close.
struct ImageViewer: View {
    let image: MessageImage
    let close: () -> Void

    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var drag: CGSize = .zero

    var body: some View {
        ZStack {
            Color.black
                .opacity(1 - min(abs(drag.height) / 400, 0.6))
                .ignoresSafeArea()
            if let decoded = InlineImage.decoded(ToolImage(data: image.data, mimeType: image.mimeType)) {
                decoded
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .offset(drag)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { scale = max(1, settledScale * $0.magnification) }
                            .onEnded { _ in settledScale = scale }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                // Zoomed in, a drag pans; at fit it's a dismiss pull.
                                drag = value.translation
                            }
                            .onEnded { value in
                                if scale <= 1, abs(value.translation.height) > 80 || abs(value.predictedEndTranslation.height) > 300 {
                                    close()
                                } else if scale <= 1 {
                                    withAnimation(.snappy) { drag = .zero }
                                }
                            }
                    )
            }
        }
        .contentShape(.rect)
        .onTapGesture(count: 2) {
            withAnimation(.snappy) {
                scale = scale > 1 ? 1 : 2.5
                settledScale = scale
                drag = .zero
            }
        }
        .onTapGesture { close() }
        .accessibilityAction(.escape) { close() }
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel("图片")
    }
}
