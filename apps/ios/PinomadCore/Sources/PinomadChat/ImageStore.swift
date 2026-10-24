import CryptoKit
import Foundation
import PinomadCore

/// Base64 image bytes plus their type and the variant the host actually
/// returned. Kept separate from the FFI record so the cache is Sendable.
public struct CachedImage: Sendable, Equatable {
    public let data: String
    public let mimeType: String
    public let variant: ImageVariant

    public init(data: String, mimeType: String, variant: ImageVariant = .original) {
        self.data = data
        self.mimeType = mimeType
        self.variant = variant
    }
}

/// Content-addressed image cache for a ref-mode conversation (ADR-0027):
/// a small decoded-byte memory tier in front of one file per ref and variant
/// under Caches. The flow is deliberately outside the session state machine —
/// fetching is a read-only `image` call and the answer belongs to the UI
/// (ADR-0024 §3 choice: nothing here feeds a snapshot).
public actor ImageStore {
    public struct Limits: Sendable {
        public var memoryBytes: Int
        public var diskBytes: Int
        public var maxInFlight: Int

        public init(
            memoryBytes: Int = 32 * 1024 * 1024,
            diskBytes: Int = 200 * 1024 * 1024,
            maxInFlight: Int = 4
        ) {
            self.memoryBytes = max(0, memoryBytes)
            self.diskBytes = max(0, diskBytes)
            self.maxInFlight = max(1, maxInFlight)
        }
    }

    public enum Failure: Error, Equatable {
        case emptyImage
    }

    private struct Key: Hashable {
        let ref: String
        let variant: ImageVariant

        var storageRef: String { "\(variant.storageName):\(ref)" }

        init(ref: String, variant: ImageVariant) {
            self.ref = ref
            self.variant = variant
        }

        init?(storageRef: String) {
            guard let separator = storageRef.firstIndex(of: ":") else {
                self.init(ref: storageRef, variant: .original)
                return
            }
            let name = String(storageRef[..<separator])
            let ref = String(storageRef[storageRef.index(after: separator)...])
            guard let variant = ImageVariant(storageName: name), !ref.isEmpty else { return nil }
            self.init(ref: ref, variant: variant)
        }
    }

    private struct MemoryEntry {
        let image: CachedImage
        let bytes: Int
        var used: UInt64
    }

    private struct DiskEntry {
        let url: URL
        let size: Int
        var used: UInt64
    }

    private let directory: URL
    private let limits: Limits
    private let limiter: Limiter
    private var memory: [Key: MemoryEntry] = [:]
    private var memoryBytes = 0
    private var disk: [Key: DiskEntry] = [:]
    private var diskBytes = 0
    private var indexed = false
    private var tick: UInt64 = 0
    private var inFlight: [Key: Task<CachedImage, Error>] = [:]
    /// Every call to `load`, including cache hits and merged requests.
    private(set) var debugLoadAttempts = 0

    public init(directory: URL? = nil, limits: Limits = .init()) {
        self.directory = directory ?? Self.defaultDirectory
        self.limits = limits
        self.limiter = Limiter(max: limits.maxInFlight)
    }

    /// Concurrent callers for one ref and variant share the in-flight task.
    /// An original already cached or in flight also serves derived display.
    public func load(
        ref: String,
        variant: ImageVariant = .original,
        using loader: @escaping @Sendable (String, ImageVariant) async throws -> CachedImage
    ) async throws -> CachedImage {
        debugLoadAttempts += 1
        let key = Key(ref: ref, variant: variant)
        if let hit = cached(key: key) { return hit }
        if variant != .original, let original = cached(ref: ref) { return original }
        if let pending = inFlight[key] {
            do {
                return try await pending.value
            } catch {
                if variant != .original {
                    return try await load(ref: ref, variant: .original, using: loader)
                }
                throw error
            }
        }
        if variant != .original, let pending = inFlight[Key(ref: ref, variant: .original)] {
            return try await pending.value
        }

        let task = Task { try await self.fetch(ref: ref, variant: variant, using: loader) }
        inFlight[key] = task
        do {
            let image = try await task.value
            inFlight[key] = nil
            return image
        } catch {
            inFlight[key] = nil
            if variant != .original {
                return try await load(ref: ref, variant: .original, using: loader)
            }
            throw error
        }
    }

    /// Warm the cache with original bytes this device just prepared. The ref
    /// is computed locally, so the first snapshot naming it needs no round trip.
    @discardableResult
    public func prefill(_ image: CachedImage) async -> String? {
        guard image.variant == .original, !image.data.isEmpty,
              let bytes = Data(base64Encoded: image.data)
        else { return nil }
        let key = Key(ref: ImageRef.of(mimeType: image.mimeType, data: image.data), variant: .original)
        ensureIndex()
        remember(image, key: key)
        writeDisk(bytes: bytes, mimeType: image.mimeType, key: key)
        return key.ref
    }

    /// A synchronous (actor-local) lookup used by `load` and tests. A disk
    /// hit is promoted to memory; a corrupt file is dropped, never trusted.
    func cached(ref: String, variant: ImageVariant = .original) -> CachedImage? {
        cached(key: Key(ref: ref, variant: variant))
    }

    private func cached(key: Key) -> CachedImage? {
        if let hit = memory[key] {
            touchMemory(key)
            return hit.image
        }
        ensureIndex()
        guard let entry = disk[key] else { return nil }
        guard let payload = Self.readPayload(at: entry.url), payload.key == key else {
            removeDisk(key)
            return nil
        }
        let image = CachedImage(
            data: payload.data.base64EncodedString(), mimeType: payload.mimeType, variant: key.variant)
        touchDisk(key)
        remember(image, key: key)
        return image
    }

    var debugDiskBytes: Int {
        ensureIndex()
        return diskBytes
    }

    // ── fetching ────────────────────────────────────────────────────────

    private func fetch(
        ref: String,
        variant: ImageVariant,
        using loader: @escaping @Sendable (String, ImageVariant) async throws -> CachedImage
    ) async throws -> CachedImage {
        await limiter.acquire()
        do {
            let image = try await loader(ref, variant)
            guard !image.data.isEmpty, let bytes = Data(base64Encoded: image.data) else {
                throw Failure.emptyImage
            }
            let actual = Key(ref: ref, variant: image.variant)
            ensureIndex()
            remember(image, key: actual)
            writeDisk(bytes: bytes, mimeType: image.mimeType, key: actual)
            await limiter.release()
            return image
        } catch {
            await limiter.release()
            throw error
        }
    }

    // ── memory LRU ──────────────────────────────────────────────────────

    private func remember(_ image: CachedImage, key: Key) {
        guard limits.memoryBytes > 0 else { return }
        let bytes = image.data.utf8.count + image.mimeType.utf8.count
        if let old = memory[key] { memoryBytes -= old.bytes }
        tick += 1
        memory[key] = MemoryEntry(image: image, bytes: bytes, used: tick)
        memoryBytes += bytes
        while memoryBytes > limits.memoryBytes, let oldest = memory.min(by: { $0.value.used < $1.value.used }) {
            memoryBytes -= oldest.value.bytes
            memory[oldest.key] = nil
        }
    }

    private func touchMemory(_ key: Key) {
        guard var entry = memory[key] else { return }
        tick += 1
        entry.used = tick
        memory[key] = entry
    }

    // ── disk LRU ────────────────────────────────────────────────────────

    private func ensureIndex() {
        guard !indexed else { return }
        indexed = true
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []

        var dates: [Key: Date] = [:]
        for url in urls where url.pathExtension == "img" {
            guard let key = Self.readKey(at: url) else {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            disk[key] = DiskEntry(url: url, size: size, used: 0)
            diskBytes += size
            dates[key] = date
        }
        for (key, _) in disk.sorted(by: { (dates[$0.key] ?? .distantPast) < (dates[$1.key] ?? .distantPast) }) {
            tick += 1
            disk[key]?.used = tick
        }
        evictDisk()
    }

    private func writeDisk(bytes: Data, mimeType: String, key: Key) {
        if let old = disk[key] {
            try? FileManager.default.removeItem(at: old.url)
            diskBytes -= old.size
            disk[key] = nil
        }
        let url = directory.appendingPathComponent(Self.fileName(for: key))
        let payload = Self.encode(key: key, mimeType: mimeType, data: bytes)
        do {
            try payload.write(to: url, options: .atomic)
        } catch {
            return
        }
        tick += 1
        disk[key] = DiskEntry(url: url, size: payload.count, used: tick)
        diskBytes += payload.count
        evictDisk()
    }

    private func touchDisk(_ key: Key) {
        guard var entry = disk[key] else { return }
        tick += 1
        entry.used = tick
        disk[key] = entry
        try? FileManager.default.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: entry.url.path
        )
    }

    private func removeDisk(_ key: Key) {
        guard let entry = disk.removeValue(forKey: key) else { return }
        diskBytes -= entry.size
        try? FileManager.default.removeItem(at: entry.url)
    }

    private func evictDisk() {
        while diskBytes > limits.diskBytes, let oldest = disk.min(by: { $0.value.used < $1.value.used }) {
            removeDisk(oldest.key)
        }
    }

    // ── file format ──────────────────────────────────────────────────────
    // One cache key per file: magic, storage-ref and MIME lengths, then the
    // raw decoded bytes. New storage refs carry a variant prefix; an old
    // unprefixed PNI1 file is an original.

    private struct Payload {
        let key: Key
        let mimeType: String
        let data: Data
    }

    private static let magic = Data("PNI1".utf8)

    private static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("Pinomad", isDirectory: true)
            .appendingPathComponent("Images", isDirectory: true)
    }

    private static func fileName(for key: Key) -> String {
        SHA256.hash(data: Data(key.storageRef.utf8)).map { String(format: "%02x", $0) }.joined() + ".img"
    }

    private static func encode(key: Key, mimeType: String, data: Data) -> Data {
        let refBytes = Data(key.storageRef.utf8)
        let mimeBytes = Data(mimeType.utf8)
        var out = magic
        append(UInt32(refBytes.count), to: &out)
        append(UInt32(mimeBytes.count), to: &out)
        out.append(refBytes)
        out.append(mimeBytes)
        out.append(data)
        return out
    }

    private static func append(_ value: UInt32, to data: inout Data) {
        var little = value.littleEndian
        withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }

    private static func decode(_ data: Data) -> Payload? {
        guard data.count >= 12, data.prefix(4) == magic else { return nil }
        let refLength = Int(readUInt32(data, at: 4))
        let mimeLength = Int(readUInt32(data, at: 8))
        let start = 12
        guard refLength >= 0, mimeLength >= 0, start + refLength + mimeLength <= data.count else { return nil }
        let refData = data.subdata(in: start..<(start + refLength))
        let mimeData = data.subdata(in: (start + refLength)..<(start + refLength + mimeLength))
        guard let storageRef = String(data: refData, encoding: .utf8),
              let key = Key(storageRef: storageRef),
              let mimeType = String(data: mimeData, encoding: .utf8)
        else { return nil }
        let bytes = data.subdata(in: (start + refLength + mimeLength)..<data.count)
        return Payload(key: key, mimeType: mimeType, data: bytes)
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        data[offset..<(offset + 4)].enumerated().reduce(0) { value, byte in
            value | (UInt32(byte.element) << (8 * byte.offset))
        }
    }

    private static func readPayload(at url: URL) -> Payload? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return decode(data)
    }

    /// File names are hashes, so startup reads only the header to recover the
    /// cache key, not the image's megabytes.
    private static func readKey(at url: URL) -> Key? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 12), head.count == 12, head.prefix(4) == magic else { return nil }
        let refLength = Int(readUInt32(head, at: 4))
        let mimeLength = Int(readUInt32(head, at: 8))
        guard refLength > 0, refLength < 4096, mimeLength < 4096 else { return nil }
        guard let refData = try? handle.read(upToCount: refLength), refData.count == refLength,
              let storageRef = String(data: refData, encoding: .utf8)
        else { return nil }
        return Key(storageRef: storageRef)
    }
}

private extension ImageVariant {
    var storageName: String {
        switch self {
        case .original: "original"
        case .thumbnail: "thumbnail"
        case .preview: "preview"
        }
    }

    init?(storageName: String) {
        switch storageName {
        case "original": self = .original
        case "thumbnail": self = .thumbnail
        case "preview": self = .preview
        default: return nil
        }
    }
}

/// A FIFO limit on simultaneous loader calls. Slots are handed to waiters
/// without bouncing through zero, so `active` never exceeds `max`.
private actor Limiter {
    private let max: Int
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(max: Int) {
        self.max = max
    }

    func acquire() async {
        if active < max {
            active += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            active -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}
