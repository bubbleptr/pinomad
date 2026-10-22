import CryptoKit
import Foundation
import PinomadCore

/// The content ref a host uses (ADR-0027): lower-case hex
/// `sha256(mimeType + "\n" + base64 data)`. Binding the MIME type keeps the
/// same bytes under PNG and JPEG apart, exactly like the TS `imageRef()`.
public enum ImageRef {
    public static func of(_ image: MessageImage) -> String {
        of(mimeType: image.mimeType, data: image.data)
    }

    public static func of(mimeType: String, data: String) -> String {
        let digest = SHA256.hash(data: Data("\(mimeType)\n\(data)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
