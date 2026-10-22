import Foundation
import ImageIO
import PinomadCore
import UniformTypeIdentifiers

/// Everything the app sends goes through one path: decode with the EXIF
/// orientation applied, cap the long side, re-encode JPEG — uniform bytes
/// on the wire, and the original metadata (GPS included) gone with the
/// original container. Uses ImageIO's thumbnail path so a 48MP photo is
/// never decoded at full size.
public enum ImagePrep {
    /// The web and Expo clients' cap.
    public static let maxSide = 1568
    static let quality = 0.85

    public struct Failure: Error, Equatable, CustomStringConvertible {
        public let description: String

        public init(description: String) {
            self.description = description
        }
    }

    public static func prepare(_ data: Data) throws -> MessageImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { throw Failure(description: "Couldn't read the image") }
        // Never upscale: the thumbnail's max side is the smaller of the cap
        // and the image's own long side.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(maxSide, max(width, height)),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Failure(description: "Couldn't read the image")
        }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw Failure(description: "Couldn't encode the image") }
        // Only the quality: no orientation (already baked in) and no
        // carried-over metadata.
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure(description: "Couldn't encode the image") }
        let prepared = MessageImage(data: (out as Data).base64EncodedString(), mimeType: "image/jpeg")
        if let problem = imageProblem(images: [prepared]) {
            throw Failure(description: problem)
        }
        return prepared
    }
}
