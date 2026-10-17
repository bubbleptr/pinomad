import Foundation
import os

/// One ordered write channel the loop owns. `send` resolves when the
/// write completed or failed — the FIFO lives in `PinomadSession`, so a
/// socket never sees two concurrent sends.
public protocol SessionSocket: Sendable {
    func send(_ data: Data) async throws
    /// Close and stop reporting events; late callbacks must be absorbed
    /// (the conn's generation is dead, the core would drop them anyway).
    func close()
}

/// Opens a connection and reports its events — opened, data, closed —
/// strictly in socket order into `sink`. At most one terminal event.
public protocol SessionSocketFactory: Sendable {
    func open(
        url: String,
        conn: UInt64,
        sink: @escaping @Sendable (SessionEvent) -> Void
    ) -> any SessionSocket
}

/// `URLSessionWebSocketTask` — the platform's own stack, so ATS, local
/// network permission, VPN, and backgrounding behave like every iOS app.
public final class URLSessionSocketFactory: SessionSocketFactory, @unchecked Sendable {
    private let delegate = WebSocketDelegate()
    private let session: URLSession

    public init(configuration: URLSessionConfiguration = .default) {
        self.session = URLSession(
            configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    public func open(
        url: String,
        conn: UInt64,
        sink: @escaping @Sendable (SessionEvent) -> Void
    ) -> any SessionSocket {
        let task = session.webSocketTask(with: URL(string: url)!)
        let socket = URLSessionSocket(conn: conn, task: task, sink: sink) { [delegate] id in
            delegate.forget(task: id)
        }
        delegate.register(socket, for: task.taskIdentifier)
        task.resume()
        return socket
    }
}

final class URLSessionSocket: SessionSocket, @unchecked Sendable {
    let conn: UInt64
    private let task: URLSessionWebSocketTask
    private let sink: @Sendable (SessionEvent) -> Void
    private let unregister: @Sendable (Int) -> Void
    private var receiver: Task<Void, Never>?
    /// One terminal event ever — didClose, didComplete, and a receive()
    /// throw can all fire for the same death.
    private let terminated = OSAllocatedUnfairLock<Bool>(initialState: false)

    init(
        conn: UInt64,
        task: URLSessionWebSocketTask,
        sink: @escaping @Sendable (SessionEvent) -> Void,
        unregister: @escaping @Sendable (Int) -> Void
    ) {
        self.conn = conn
        self.task = task
        self.sink = sink
        self.unregister = unregister
    }

    /// `didOpen` — the handshake really finished, so `socketOpened`
    /// precedes any frame the receive loop can pull (records buffered by
    /// URLSession stay ordered). The loop only starts here.
    func opened() {
        sink(.socketOpened(conn: conn))
        receiver = Task { [self, sink] in
            while !Task.isCancelled {
                do {
                    let bytes: Data
                    switch try await task.receive() {
                    case .data(let data): bytes = data
                    case .string(let text): bytes = Data(text.utf8)
                    @unknown default: continue
                    }
                    sink(.socketData(conn: conn, bytes: bytes))
                } catch {
                    deliverClosed(code: 1006, reason: error.localizedDescription)
                    return
                }
            }
        }
    }

    func closed(code: UInt16, reason: String?) {
        deliverClosed(code: code, reason: reason)
    }

    private func deliverClosed(code: UInt16, reason: String?) {
        let first = terminated.withLock { seen -> Bool in
            if seen { return false }
            seen = true
            return true
        }
        if first {
            sink(.socketClosed(conn: conn, code: code, reason: reason))
        }
    }

    func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    func close() {
        receiver?.cancel()
        task.cancel(with: .normalClosure, reason: nil)
        unregister(task.taskIdentifier)
    }
}

/// Routes URLSession's per-task delegate callbacks to the socket that
/// owns the task. `delegateQueue: nil` gives callback ordering on a
/// private queue; each socket still serializes via the session queue.
final class WebSocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let sockets = OSAllocatedUnfairLock<[Int: URLSessionSocket]>(initialState: [:])

    func register(_ socket: URLSessionSocket, for taskIdentifier: Int) {
        sockets.withLock { $0[taskIdentifier] = socket }
    }

    func forget(task taskIdentifier: Int) {
        _ = sockets.withLock { $0.removeValue(forKey: taskIdentifier) }
    }

    private func socket(for task: URLSessionWebSocketTask) -> URLSessionSocket? {
        sockets.withLock { $0[task.taskIdentifier] }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol `protocol`: String?
    ) {
        socket(for: webSocketTask)?.opened()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        forget(task: webSocketTask.taskIdentifier)
        socket(for: webSocketTask)?.closed(
            code: UInt16(clamping: closeCode.rawValue),
            reason: reason.flatMap { String(data: $0, encoding: .utf8) }
        )
    }

    /// A handshake or transport failure that never produced a close
    /// frame — surfaced as abnormal (1006), like a dropped TCP link.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        guard let error, let task = task as? URLSessionWebSocketTask else { return }
        forget(task: task.taskIdentifier)
        socket(for: task)?.closed(code: 1006, reason: error.localizedDescription)
    }
}
