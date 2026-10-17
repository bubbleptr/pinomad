import Foundation
import QuartzCore

/// Optional delivery-latency recorder for on-device perf runs (ADR-0024
/// §5). `xctrace --attach` cannot see processes on this iOS/Xcode combo,
/// so the session timestamps the same events the os_signpost markers
/// emit (`bytes` / `snapshot` / `publish`, plus `ui-publish` from the
/// app) into a ring buffer persisted at `Documents/perf.ndjson` — pull it
/// with `devicectl device copy from --domain-type appDataContainer`.
/// Enabled only when `PINOMAD_PERFLOG` is in the environment; a no-op
/// otherwise.
public final class PerfLog: @unchecked Sendable {
    public static let shared = PerfLog()

    public struct Event: Sendable {
        let t: Double // epoch ms
        let name: String
        let version: UInt64?
        let ms: Double? // interval measurements (snapshot compute time, hitch gap)
        let span: Double? // expected frame interval for hitch events
        let mem: Double? // resident memory MB at the mark
    }

    public let enabled: Bool
    private var events: [Event] = []
    private let lock = NSLock()
    private static let fileName = "perf.ndjson"

    init() {
        enabled = ProcessInfo.processInfo.environment["PINOMAD_PERFLOG"] != nil
    }

    public func mark(_ name: String, version: UInt64? = nil) {
        record(name, version: version, ms: nil, span: nil)
    }

    public func measure(_ name: String, ms: Double, version: UInt64? = nil) {
        record(name, version: version, ms: ms, span: nil)
    }

    private func record(_ name: String, version: UInt64?, ms: Double?, span: Double? = nil) {
        guard enabled else { return }
        lock.lock()
        events.append(Event(t: Date().timeIntervalSince1970 * 1000, name: name, version: version, ms: ms, span: span, mem: Self.footprint()))
        lock.unlock()
    }

    /// Rewrite the whole buffer — few hundred lines per run, simpler and
    /// crash-safe vs append bookkeeping.
    public func flush() {
        guard enabled else { return }
        lock.lock(); let copy = events; lock.unlock()
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let lines = copy.map { e -> String in
            var parts = ["\"t\":\(e.t)", "\"n\":\"\(e.name)\""]
            if let v = e.version { parts.append("\"v\":\(v)") }
            if let m = e.ms { parts.append("\"ms\":\(m)") }
            if let s = e.span { parts.append("\"span\":\(s)") }
            if let m = e.mem { parts.append("\"mem\":\(m)") }
            return "{\(parts.joined(separator: ","))}"
        }
        try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent(Self.fileName), atomically: true, encoding: .utf8)
    }

    /// Start counting dropped frames via CADisplayLink. Each stall — a
    /// frame gap longer than two expected frame intervals — lands as a
    /// `hitch` event whose `ms` is the gap and `span` the expected frame.
    /// Call on the main thread; runs only while `enabled`.
    public func startFrameMonitor() {
        guard enabled, Thread.isMainThread, monitor == nil else { return }
        monitor = FrameMonitor { [weak self] gapMs, frameMs in
            self?.record("hitch", version: nil, ms: gapMs, span: frameMs)
        }
    }

    private var monitor: FrameMonitor?

    /// Resident size in MB — good enough for the 250 MB budget check.
    private static func footprint() -> Double? {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : nil
    }
}

/// Counts dropped frames on the main run loop: the CADisplayLink tick
/// fires once per expected frame, so a hitching main thread shows up as
/// a gap between ticks longer than two frame intervals.
private final class FrameMonitor: NSObject {
    private let onStall: (Double, Double) -> Void
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0

    init(onStall: @escaping (Double, Double) -> Void) {
        self.onStall = onStall
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        let frame = (link.targetTimestamp - link.timestamp) * 1000
        if last > 0 {
            let gap = (link.timestamp - last) * 1000
            if gap > 2 * frame { onStall(gap, frame) }
        }
        last = link.timestamp
    }

    deinit { link?.invalidate() }
}
