import Foundation

/// Consumes one session's update stream. A first-connect timeout closes the
/// session but leaves this loop running: updates the core already emitted
/// (notably `.paired`) are applied in order, and the timeout handler runs
/// only after the stream ends — and only if `.ready` never arrived.
@MainActor
public final class ConnectAttempt {
    public typealias UpdateHandler = @MainActor (SessionUpdate) -> Void
    public typealias TimeoutHandler = @MainActor (String?) -> Void

    private let updates: AsyncStream<SessionUpdate>
    private let close: @MainActor () -> Void
    private let apply: UpdateHandler
    private let onTimeout: TimeoutHandler
    private let onFinished: (@MainActor () -> Void)?
    private var task: Task<Void, Never>?
    private var ready = false
    private var timedOut = false
    private var timeoutAddress: String?
    private var finished = false

    public init(
        updates: AsyncStream<SessionUpdate>,
        close: @escaping @MainActor () -> Void,
        apply: @escaping UpdateHandler,
        onTimeout: @escaping TimeoutHandler,
        onFinished: (@MainActor () -> Void)? = nil
    ) {
        self.updates = updates
        self.close = close
        self.apply = apply
        self.onTimeout = onTimeout
        self.onFinished = onFinished
    }

    public func start() {
        task?.cancel()
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            for await update in self.updates {
                guard !Task.isCancelled else { return }
                self.receive(update)
            }
            guard !Task.isCancelled else { return }
            self.finish()
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// Stop the session without stopping the drain. The failure page waits
    /// for the update stream to end so a queued `.paired` still lands.
    public func timeout(address: String?) {
        guard !finished, !ready, !timedOut else { return }
        timedOut = true
        timeoutAddress = address
        close()
    }

    private func receive(_ update: SessionUpdate) {
        if case .ready = update { ready = true }
        apply(update)
    }

    private func finish() {
        finished = true
        onFinished?()
        guard timedOut, !ready else { return }
        onTimeout(timeoutAddress)
    }
}
