import AgentChatCore
import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// An image that arrived as base64 data — a user's attachment or a tool
/// result's picture. The payload is decoded once per unique string: a
/// transcript republishes whole on every update, and without a cache each
/// render pass would pay the decode again.
public struct InlineImage: View {
    /// The decoded picture, from the same cache the view draws with — for
    /// callers that lay it out themselves (crops, a full-screen viewer).
    public static func decoded(_ image: ToolImage) -> Image? {
        InlineImageCache.image(for: image)
    }

    let image: ToolImage
    let maxWidth: CGFloat
    let maxHeight: CGFloat

    public init(_ image: ToolImage, maxWidth: CGFloat = 320, maxHeight: CGFloat = 240) {
        self.image = image
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
    }

    @Environment(\.inlineImageAction) private var action

    public var body: some View {
        if let decoded = InlineImageCache.image(for: image) {
            let shown = decoded
                .resizable()
                .scaledToFit()
                .frame(maxWidth: maxWidth, maxHeight: maxHeight, alignment: .leading)
                .clipShape(.rect(cornerRadius: 10))
            if let action {
                shown
                    .onTapGesture { action.open(image) }
                    .accessibilityAddTraits(.isButton)
            } else {
                shown
            }
        } else {
            Text("Image (\(image.mimeType))", bundle: .module)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}

enum InlineImageCache {
    /// `Image` is a struct; NSCache wants a class.
    private final class Box {
        let image: Image
        init(_ image: Image) { self.image = image }
    }

    // NSCache carries its own locking; the compiler cannot see that.
    private nonisolated(unsafe) static let cache = NSCache<NSString, Box>()

    static func image(for image: ToolImage) -> Image? {
        let key = image.data as NSString
        if let hit = cache.object(forKey: key) { return hit.image }
        guard let bytes = Data(base64Encoded: image.data) else { return nil }
        #if canImport(UIKit)
        let decoded = UIImage(data: bytes).map { Image(uiImage: $0) }
        #elseif canImport(AppKit)
        let decoded = NSImage(data: bytes).map { Image(nsImage: $0) }
        #else
        let decoded: Image? = nil
        #endif
        if let decoded { cache.setObject(Box(decoded), forKey: key) }
        return decoded
    }
}

/// What tapping an inline image does — e.g. open it full screen. Set it
/// once high in the tree; images without one are inert.
public struct InlineImageAction {
    let open: (ToolImage) -> Void

    public init(_ open: @escaping (ToolImage) -> Void) {
        self.open = open
    }
}

extension EnvironmentValues {
    @Entry public var inlineImageAction: InlineImageAction?
}
