import CryptoKit
import Foundation

/// Base64 image bytes plus their type — the cache's value type. Kept
/// separate from PinomadCore's FFI record so the cache is Sendable and the
/// platform layer does not smuggle a generated record across actors.
public struct CachedImage: Sendable, Equatable {
    public let data: String
    public let mimeType: String

    public init(data: String, mimeType: String) {
        self.data = data
        self.mimeType = mimeType
    }
}

/// Content-addressed image cache for a ref-mode conversation (ADR-0027):
/// a small decoded-byte memory tier in front of one file per ref under
/// Caches. The flow is deliberately outside the session state machine —
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
    private var memory: [String: MemoryEntry] = [:]
    private var memoryBytes = 0
    private var disk: [String: DiskEntry] = [:]
    private var diskBytes = 0
    private var indexed = false
    private var tick: UInt64 = 0
    private var inFlight: [String: Task<CachedImage, Error>] = [:]
    /// Every call to `load`, including cache hits and merged requests.
    private(set) var debugLoadAttempts = 0

    public init(directory: URL? = nil, limits: Limits = .init()) {
        self.directory = directory ?? Self.defaultDirectory
        self.limits = limits
        self.limiter = Limiter(max: limits.maxInFlight)
    }

    /// One ref, one request: concurrent callers share the in-flight task. A
    /// failure removes it, so the next appearance of the image retries.
    public func load(
        ref: String,
        using loader: @escaping @Sendable (String) async throws -> CachedImage
    ) async throws -> CachedImage {
        debugLoadAttempts += 1
        if let hit = cached(ref: ref) { return hit }
        if let pending = inFlight[ref] { return try await pending.value }

        let task = Task { try await self.fetch(ref: ref, using: loader) }
        inFlight[ref] = task
        do {
            let image = try await task.value
            inFlight[ref] = nil
            return image
        } catch {
            inFlight[ref] = nil
            throw error
        }
    }

    /// Warm the cache with bytes this device just prepared. The ref is
    /// computed locally, so the first snapshot naming it needs no round trip.
    @discardableResult
    public func prefill(_ image: CachedImage) async -> String? {
        guard !image.data.isEmpty, let bytes = Data(base64Encoded: image.data) else { return nil }
        let ref = ImageRef.of(mimeType: image.mimeType, data: image.data)
        ensureIndex()
        remember(image, ref: ref)
        writeDisk(bytes: bytes, mimeType: image.mimeType, ref: ref)
        return ref
    }

    /// A synchronous (actor-local) lookup used by `load` and tests. A disk
    /// hit is promoted to memory; a corrupt file is dropped, never trusted.
    func cached(ref: String) -> CachedImage? {
        if let hit = memory[ref] {
            touchMemory(ref)
            return hit.image
        }
        ensureIndex()
        guard let entry = disk[ref] else { return nil }
        guard let payload = Self.readPayload(at: entry.url) else {
            removeDisk(ref)
            return nil
        }
        let image = CachedImage(data: payload.data.base64EncodedString(), mimeType: payload.mimeType)
        touchDisk(ref)
        remember(image, ref: ref)
        return image
    }

    var debugDiskBytes: Int {
        ensureIndex()
        return diskBytes
    }

    // ── fetching ────────────────────────────────────────────────────────

    private func fetch(
        ref: String,
        using loader: @escaping @Sendable (String) async throws -> CachedImage
    ) async throws -> CachedImage {
        await limiter.acquire()
        do {
            let image = try await loader(ref)
            guard !image.data.isEmpty, let bytes = Data(base64Encoded: image.data) else {
                throw Failure.emptyImage
            }
            ensureIndex()
            remember(image, ref: ref)
            writeDisk(bytes: bytes, mimeType: image.mimeType, ref: ref)
            await limiter.release()
            return image
        } catch {
            await limiter.release()
            throw error
        }
    }

    // ── memory LRU ──────────────────────────────────────────────────────

    private func remember(_ image: CachedImage, ref: String) {
        guard limits.memoryBytes > 0 else { return }
        let bytes = image.data.utf8.count + image.mimeType.utf8.count
        if let old = memory[ref] { memoryBytes -= old.bytes }
        tick += 1
        memory[ref] = MemoryEntry(image: image, bytes: bytes, used: tick)
        memoryBytes += bytes
        while memoryBytes > limits.memoryBytes, let oldest = memory.min(by: { $0.value.used < $1.value.used }) {
            memoryBytes -= oldest.value.bytes
            memory[oldest.key] = nil
        }
    }

    private func touchMemory(_ ref: String) {
        guard var entry = memory[ref] else { return }
        tick += 1
        entry.used = tick
        memory[ref] = entry
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

        var dates: [String: Date] = [:]
        for url in urls where url.pathExtension == "img" {
            guard let ref = Self.readRef(at: url) else {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            disk[ref] = DiskEntry(url: url, size: size, used: 0)
            diskBytes += size
            dates[ref] = date
        }
        for (ref, _) in disk.sorted(by: { (dates[$0.key] ?? .distantPast) < (dates[$1.key] ?? .distantPast) }) {
            tick += 1
            disk[ref]?.used = tick
        }
        evictDisk()
    }

    private func writeDisk(bytes: Data, mimeType: String, ref: String) {
        if let old = disk[ref] {
            try? FileManager.default.removeItem(at: old.url)
            diskBytes -= old.size
            disk[ref] = nil
        }
        let url = directory.appendingPathComponent(Self.fileName(for: ref))
        let payload = Self.encode(ref: ref, mimeType: mimeType, data: bytes)
        do {
            try payload.write(to: url, options: .atomic)
        } catch {
            return
        }
        tick += 1
        disk[ref] = DiskEntry(url: url, size: payload.count, used: tick)
        diskBytes += payload.count
        evictDisk()
    }

    private func touchDisk(_ ref: String) {
        guard var entry = disk[ref] else { return }
        tick += 1
        entry.used = tick
        disk[ref] = entry
        try? FileManager.default.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: entry.url.path
        )
    }

    private func removeDisk(_ ref: String) {
        guard let entry = disk.removeValue(forKey: ref) else { return }
        diskBytes -= entry.size
        try? FileManager.default.removeItem(at: entry.url)
    }

    private func evictDisk() {
        while diskBytes > limits.diskBytes, let oldest = disk.min(by: { $0.value.used < $1.value.used }) {
            removeDisk(oldest.key)
        }
    }

    // ── file format ──────────────────────────────────────────────────────
    // One ref per file: magic, ref and MIME lengths, then the raw decoded
    // bytes. Storing decoded bytes keeps startup reads cheap and avoids
    // carrying the wire's base64 inflation on disk.

    private struct Payload {
        let ref: String
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

    private static func fileName(for ref: String) -> String {
        SHA256.hash(data: Data(ref.utf8)).map { String(format: "%02x", $0) }.joined() + ".img"
    }

    private static func encode(ref: String, mimeType: String, data: Data) -> Data {
        let refBytes = Data(ref.utf8)
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
        guard let ref = String(data: refData, encoding: .utf8),
              let mimeType = String(data: mimeData, encoding: .utf8)
        else { return nil }
        let bytes = data.subdata(in: (start + refLength + mimeLength)..<data.count)
        return Payload(ref: ref, mimeType: mimeType, data: bytes)
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

    /// File names are hashes, so startup must read the header to learn which
    /// ref a file belongs to. Only the header is read, not the megabytes.
    private static func readRef(at url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 12), head.count == 12, head.prefix(4) == magic else { return nil }
        let refLength = Int(readUInt32(head, at: 4))
        let mimeLength = Int(readUInt32(head, at: 8))
        guard refLength > 0, refLength < 4096, mimeLength < 4096 else { return nil }
        guard let refData = try? handle.read(upToCount: refLength), refData.count == refLength else { return nil }
        return String(data: refData, encoding: .utf8)
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
