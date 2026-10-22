import Foundation
import PinomadCore
import Testing
@testable import PinomadChat

@Suite struct ImageRefTests {
    /// The same fixed input the TS `imageRef()` hashes in
    /// packages/protocol/src/images.ts. The constant came from:
    /// `bun -e 'import { imageRef } from "./packages/protocol/src/images.ts";
    /// console.log(await imageRef({ mimeType: "image/png", data: "..." }))'`
    /// — Swift must agree byte for byte, or prefilled cache keys never hit.
    @Test func refMatchesTheProtocolReference() {
        let image = MessageImage(
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            mimeType: "image/png"
        )
        #expect(ImageRef.of(image) == "0229294eeb80847cbdc480bb8730e4702362736d7752b2f3f6d339a975dd6a71")
    }

    /// The line between type and bytes is part of the contract: the same
    /// base64 under another MIME type is a different image.
    @Test func refBindsTheMimeType() {
        let data = "AAAA"
        #expect(ImageRef.of(mimeType: "image/png", data: data) != ImageRef.of(mimeType: "image/jpeg", data: data))
    }
}
