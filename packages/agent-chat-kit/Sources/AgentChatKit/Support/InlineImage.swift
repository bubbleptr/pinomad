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
    let image: ToolImage
    let maxWidth: CGFloat
    let maxHeight: CGFloat

    public init(_ image: ToolImage, maxWidth: CGFloat = 320, maxHeight: CGFloat = 240) {
        self.image = image
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
    }

    public var body: some View {
        if let decoded = InlineImageCache.image(for: image) {
            decoded
                .resizable()
                .scaledToFit()
                .frame(maxWidth: maxWidth, maxHeight: maxHeight, alignment: .leading)
                .clipShape(.rect(cornerRadius: 10))
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
