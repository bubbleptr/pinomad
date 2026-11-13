/// How a toast reads: its icon, tint, haptic, and whether it waits.
public enum ToastLevel: String, Sendable {
    case info, success, warning, error

    /// A host or core notice's level; anything unknown reads as info.
    public init(host level: String) {
        self = ToastLevel(rawValue: level) ?? .info
    }
}

public struct Toast: Equatable, Identifiable, Sendable {
    public let id: UInt64
    public let level: ToastLevel
    public let message: String
    /// The action it reports, so its next failure replaces it and a retry
    /// clears it.
    public let key: String?

    /// An error waits until the reader closes it; the rest leave on their own.
    public var sticky: Bool { level == .error }
}

/// The toasts on screen, newest last.
public struct ToastQueue: Sendable {
    public static let limit = 3

    public private(set) var toasts: [Toast] = []
    private var nextID: UInt64 = 0

    public init() {}

    @discardableResult
    public mutating func show(_ message: String, level: ToastLevel, key: String? = nil) -> Toast {
        nextID &+= 1
        let toast = Toast(id: nextID, level: level, message: message, key: key)
        if let key { toasts.removeAll { $0.key == key } }
        toasts.append(toast)
        if toasts.count > Self.limit { toasts.removeFirst(toasts.count - Self.limit) }
        return toast
    }

    public mutating func dismiss(_ id: UInt64) {
        toasts.removeAll { $0.id == id }
    }

    public mutating func clear(key: String) {
        toasts.removeAll { $0.key == key }
    }
}
