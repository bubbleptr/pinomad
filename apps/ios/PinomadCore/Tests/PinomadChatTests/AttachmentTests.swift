import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import PinomadChat
import PinomadCore

private let jpeg = MessageImage(data: "AAAA", mimeType: "image/jpeg")

@Suite struct AttachmentTrayTests {
    @Test func reservingPastTheLimitKeepsWhatFitsAndSaysWhy() throws {
        var tray = AttachmentTray(limit: 4)
        let firstClaim = tray.reserve(3, accepts: true)
        let first = try #require(firstClaim)
        #expect(first.count == 3)
        let secondClaim = tray.reserve(3, accepts: true)
        let second = try #require(secondClaim)
        #expect(second.count == 1)
        #expect(tray.error == "最多 4 张图片")
        #expect(tray.freeSlots == 0)
        let none = tray.reserve(1, accepts: true)
        #expect(none == nil)
    }

    @Test func aModelWithoutImagesRefuses() {
        var tray = AttachmentTray(limit: 4)
        let refused = tray.reserve(1, accepts: false)
        #expect(refused == nil)
        #expect(tray.error != nil)
        #expect(tray.freeSlots == 4)
    }

    @Test func preparedImagesLandInOrder() throws {
        var tray = AttachmentTray(limit: 4)
        let slotClaim = tray.reserve(2, accepts: true)
        let slot = try #require(slotClaim)
        #expect(tray.preparing == 2)
        tray.fulfil(slot, with: [jpeg, MessageImage(data: "BBBB", mimeType: "image/jpeg")])
        #expect(tray.preparing == 0)
        #expect(tray.images.map(\.data) == ["AAAA", "BBBB"])
        #expect(tray.freeSlots == 2)
    }

    /// One unreadable image drops the whole batch with its reason, rather
    /// than silently attaching part of the selection.
    @Test func aFailedBatchFreesItsSlots() throws {
        var tray = AttachmentTray(limit: 4)
        let slotClaim = tray.reserve(2, accepts: true)
        let slot = try #require(slotClaim)
        tray.fail(slot, message: "无法读取图片")
        #expect(tray.images.isEmpty)
        #expect(tray.preparing == 0)
        #expect(tray.freeSlots == 4)
        #expect(tray.error == "无法读取图片")
    }

    /// Sending clears the tray; an image still being prepared must not
    /// come back afterwards and ride along with the next message.
    @Test func clearingDropsLateResults() throws {
        var tray = AttachmentTray(limit: 4)
        let slotClaim = tray.reserve(1, accepts: true)
        let slot = try #require(slotClaim)
        tray.clear()
        tray.fulfil(slot, with: [jpeg])
        #expect(tray.images.isEmpty)
        #expect(tray.preparing == 0)
        #expect(tray.freeSlots == 4)
    }

    /// Reconnecting rebuilds the trays while an old batch may still be
    /// preparing; its result must not land in the new tray (it would push
    /// `preparing` negative and attach an image the reader never saw).
    @Test func aReservationFromAReplacedTrayIsIgnored() throws {
        var old = AttachmentTray(limit: 4)
        let staleClaim = old.reserve(1, accepts: true)
        let stale = try #require(staleClaim)
        var tray = AttachmentTray(limit: 4)
        let freshClaim = tray.reserve(1, accepts: true)
        let fresh = try #require(freshClaim)
        tray.fulfil(stale, with: [jpeg])
        tray.fail(stale, message: "x")
        #expect(tray.preparing == 1)
        #expect(tray.images.isEmpty)
        #expect(tray.error == nil)
        tray.fulfil(fresh, with: [jpeg])
        #expect(tray.preparing == 0)
        #expect(tray.images.count == 1)
    }

    @Test func removingAnImageFreesItsSlot() throws {
        var tray = AttachmentTray(limit: 4)
        let slotClaim = tray.reserve(1, accepts: true)
        let slot = try #require(slotClaim)
        tray.fulfil(slot, with: [jpeg])
        tray.remove(at: 0)
        #expect(tray.images.isEmpty)
        #expect(tray.freeSlots == 4)
    }

    /// Edit replaces whatever was staged with the withdrawn copy, keeps the
    /// per-message cap, and ignores a prepare that was still in flight.
    @Test func restoringAnEditReplacesTheTrayAndKeepsTheLimit() throws {
        var tray = AttachmentTray(limit: 4)
        let staleClaim = tray.reserve(1, accepts: true)
        let stale = try #require(staleClaim)
        let restored = (0..<5).map { MessageImage(data: "B\($0)", mimeType: "image/jpeg") }

        tray.restore(restored)
        tray.fulfil(stale, with: [jpeg])

        #expect(tray.images.count == 4)
        #expect(tray.images.map(\.data) == ["B0", "B1", "B2", "B3"])
        #expect(tray.preparing == 0)
        #expect(tray.freeSlots == 0)
        #expect(tray.error == "最多 4 张图片")
    }
}

@Suite struct SendSlotImageTests {
    @Test func imagesAloneCanBeSent() {
        #expect(SendSlot(draft: "", connected: true, busy: false, hasImages: true)
            == .send(enabled: true, canSteer: false))
    }

    /// Preparing blocks sending (the images aren't ready) but never Stop.
    @Test func preparingBlocksSendOnly() {
        #expect(SendSlot(draft: "hi", connected: true, busy: false, preparing: true)
            == .send(enabled: false, canSteer: false))
        #expect(SendSlot(draft: "", connected: true, busy: true, preparing: true)
            == .stop(enabled: true))
    }
}

@Suite struct ImagePrepTests {
    /// A JPEG of the given size with an EXIF orientation and a GPS block,
    /// like a phone photo.
    private func photo(width: Int, height: Int, orientation: Int) throws -> Data {
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let out = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = [
            kCGImagePropertyOrientation: orientation,
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 31.2, kCGImagePropertyGPSLongitude: 121.5],
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return out as Data
    }

    private func decoded(_ image: MessageImage) throws -> (width: Int, height: Int, properties: [CFString: Any]) {
        let data = try #require(Data(base64Encoded: image.data))
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let width = try #require(properties[kCGImagePropertyPixelWidth] as? Int)
        let height = try #require(properties[kCGImagePropertyPixelHeight] as? Int)
        return (width, height, properties)
    }

    /// Long side capped, EXIF rotation baked into the pixels (orientation 6
    /// is "rotate 90°", so a landscape file comes out portrait), and the
    /// GPS block gone with the original container.
    @Test func phonePhotoIsCappedRotatedAndStripped() throws {
        let prepared = try ImagePrep.prepare(try photo(width: 3000, height: 1000, orientation: 6))
        #expect(prepared.mimeType == "image/jpeg")
        let out = try decoded(prepared)
        #expect(max(out.width, out.height) == 1568)
        #expect(out.height > out.width)
        #expect(out.properties[kCGImagePropertyGPSDictionary] == nil)
        #expect((out.properties[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
    }

    @Test func smallImagesAreNotUpscaled() throws {
        let out = try decoded(try ImagePrep.prepare(try photo(width: 800, height: 600, orientation: 1)))
        #expect(out.width == 800)
        #expect(out.height == 600)
    }

    @Test func unreadableBytesFail() {
        #expect(throws: ImagePrep.Failure.self) {
            try ImagePrep.prepare(Data("not an image".utf8))
        }
    }
}
