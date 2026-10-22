import Foundation
import PinomadCore

/// The composer's staged images: what's ready, how many are still being
/// prepared, and the last problem the reader hit. Slots are reserved up
/// front, so two quick picks can't both see the same free room. The host
/// enforces the same limits — this is the friendly pre-check.
public struct AttachmentTray: Equatable, Sendable {
    /// A claim on slots for a batch being prepared.
    public struct Reservation: Equatable, Sendable {
        public let count: Int
        let tray: UUID
        let generation: Int
    }

    /// Which tray this is: a reservation only lands in the tray that made
    /// it, not in a replacement (reconnecting rebuilds every tray while an
    /// old batch may still be preparing).
    private let identity = UUID()

    public private(set) var images: [MessageImage] = []
    public private(set) var preparing = 0
    public private(set) var error: String?
    private let limit: Int
    /// Staged + in-flight.
    private var taken = 0
    /// Bumped by `clear()` so a batch that finishes after a send can't
    /// come back with the next message.
    private var generation = 0

    public init(limit: Int = Int(maxImagesPerMessage())) {
        self.limit = limit
    }

    public var freeSlots: Int { max(0, limit - taken) }
    public var isEmpty: Bool { images.isEmpty && preparing == 0 }

    /// Claim up to `count` slots; nil when nothing fits (the reason is in
    /// `error`).
    public mutating func reserve(_ count: Int, accepts: Bool) -> Reservation? {
        guard accepts else {
            error = "当前模型不支持图片"
            return nil
        }
        let kept = min(count, freeSlots)
        error = count > kept ? "最多 \(limit) 张图片" : nil
        guard kept > 0 else { return nil }
        taken += kept
        preparing += kept
        return Reservation(count: kept, tray: identity, generation: generation)
    }

    private func owns(_ reservation: Reservation) -> Bool {
        reservation.tray == identity && reservation.generation == generation
    }

    public mutating func fulfil(_ reservation: Reservation, with prepared: [MessageImage]) {
        guard owns(reservation) else { return }
        preparing -= reservation.count
        images += prepared
    }

    /// One unreadable image drops its whole batch, with the reason.
    public mutating func fail(_ reservation: Reservation, message: String) {
        guard owns(reservation) else { return }
        preparing -= reservation.count
        taken -= reservation.count
        error = message
    }

    public mutating func remove(at index: Int) {
        guard images.indices.contains(index) else { return }
        images.remove(at: index)
        taken -= 1
    }

    /// A problem that never reached `reserve` (e.g. an empty clipboard).
    public mutating func report(_ message: String) {
        error = message
    }

    /// Replace the staged images with already-prepared ones, as an Edit
    /// does. The withdrawn images were admitted before, so a model that no
    /// longer accepts images must not drop them; the generation bump keeps a
    /// batch still preparing from appending to the restored set.
    public mutating func restore(_ images: [MessageImage]) {
        let kept = Array(images.prefix(limit))
        generation += 1
        self.images = kept
        preparing = 0
        taken = kept.count
        error = images.count > limit ? "最多 \(limit) 张图片" : nil
    }

    public mutating func clear() {
        images = []
        preparing = 0
        taken = 0
        error = nil
        generation += 1
    }
}
