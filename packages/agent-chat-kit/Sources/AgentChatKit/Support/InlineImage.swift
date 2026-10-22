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
///
/// In ref mode (ADR-0027) `image.data` is empty and `image.ref` names bytes
/// the app fetches. The kit has no host dependency: the app injects
/// `inlineImageLoader` and this view calls it when it appears.
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
    @Environment(\.inlineImageLoader) private var loader
    /// Bumped by the app when connectivity returns, so a failed ref retries
    /// without waiting for the row to scroll away and back.
    @Environment(\.inlineImageEpoch) private var epoch
    @State private var fetched: ToolImage?
    @State private var failed = false

    private var ref: String? {
        guard image.data.isEmpty, let ref = image.ref, !ref.isEmpty else { return nil }
        return ref
    }

    private var displayed: ToolImage? {
        if !image.data.isEmpty { return image }
        return fetched
    }

    /// Ref images occupy one fixed 4:3 box from the first frame: the bytes
    /// are not known until the fetch lands, so this is what keeps the row
    /// from jumping when they arrive.
    private var placeholderHeight: CGFloat { min(maxHeight, maxWidth * 0.75) }

    public var body: some View {
        Group {
            if let displayed {
                inline(displayed)
            } else if ref != nil {
                placeholder
            } else {
                Text("Image (\(image.mimeType))", bundle: .module)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .task(id: "\(image.id):\(epoch)") {
            await fetchIfNeeded()
        }
        .onChange(of: image.id) {
            fetched = nil
            failed = false
        }
    }

    @ViewBuilder
    private func inline(_ image: ToolImage) -> some View {
        if let decoded = InlineImageCache.image(for: image) {
            let framed: some View = decoded
                .resizable()
                .scaledToFit()
                .frame(
                    width: ref == nil ? nil : maxWidth,
                    height: ref == nil ? nil : placeholderHeight,
                    alignment: .leading
                )
                .frame(maxWidth: ref == nil ? maxWidth : nil,
                       maxHeight: ref == nil ? maxHeight : nil,
                       alignment: .leading)
                .clipShape(.rect(cornerRadius: 10))
            if let action {
                framed
                    .onTapGesture { action.open(image) }
                    .accessibilityAddTraits(.isButton)
            } else {
                framed
            }
        } else if ref != nil {
            failurePlaceholder
        } else {
            Text("Image (\(image.mimeType))", bundle: .module)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if failed {
            failurePlaceholder
        } else {
            RoundedRectangle(cornerRadius: 10)
                .fill(.fill.quaternary)
                .frame(width: maxWidth, height: placeholderHeight)
                .overlay { ProgressView().controlSize(.mini) }
                .accessibilityLabel(Text("Loading image", bundle: .module))
        }
    }

    private var failurePlaceholder: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(.fill.quaternary)
            .frame(width: maxWidth, height: placeholderHeight)
            .overlay {
                Image(Icon.circleX)
                    .font(.title3)
                    .foregroundStyle(.tertiary)
            }
            .accessibilityLabel(Text("Couldn't load image", bundle: .module))
    }

    private func fetchIfNeeded() async {
        guard let ref else { return }
        failed = false
        guard let loader else {
            failed = true
            return
        }
        do {
            let image = try await loader.image(for: ref)
            guard !image.data.isEmpty else {
                failed = true
                return
            }
            fetched = image
            failed = false
        } catch {
            failed = true
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

/// Fetches the bytes a ref names. The app injects the implementation (its
/// cache and `image` call), so AgentChatKit stays independent of PinomadCore.
public struct InlineImageLoader: Sendable {
    public typealias Load = @Sendable (String) async throws -> ToolImage
    private let load: Load

    public init(_ load: @escaping Load) {
        self.load = load
    }

    public func image(for ref: String) async throws -> ToolImage {
        try await load(ref)
    }
}

extension EnvironmentValues {
    @Entry public var inlineImageAction: InlineImageAction?
    @Entry public var inlineImageLoader: InlineImageLoader?
    @Entry public var inlineImageEpoch: UInt64 = 0
}
