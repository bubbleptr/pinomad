import Foundation

/// What a push-registration opportunity should put on the wire. Kept as a
/// value so the app layer only maps it to `FfiCall.setPushToken`.
public enum PushRegistrationAction: Equatable, Sendable {
    /// Nothing to send: the host is too old, or APNs has not issued a
    /// token yet.
    case none
    case register(ApnsPushToken)
    /// `setPushToken(null)`; a 5.7 host knows the call even though it does
    /// not know the APNs object form.
    case unregister
}

/// The action for one opportunity (connect, reconnect, foreground, or the
/// switch changing) — ADR-0025 §9. Registration needs both a 5.9 host and
/// a token; clearing only needs the 5.7 call.
public func pushRegistrationAction(
    enabled: Bool,
    hostMinor: UInt32,
    deviceToken: String?,
    environment: ApnsEnvironment
) -> PushRegistrationAction {
    guard hostSupportsCall(hostMinor: hostMinor, method: "setPushToken") else { return .none }
    guard enabled else { return .unregister }
    guard hostSupportsFeature(hostMinor: hostMinor, feature: .apnsPush),
          let deviceToken, !deviceToken.isEmpty
    else { return .none }
    return .register(ApnsPushToken(apns: deviceToken, environment: environment))
}

/// A foreground banner is suppressed only for the host on screen right now;
/// pushes from the reader's other hosts still show (ADR-0025 §9).
public func shouldPresentPushBanner(pushHostKey: String?, currentHostKey: String?) -> Bool {
    guard let pushHostKey else { return true }
    return pushHostKey != currentHostKey
}

/// The custom payload a tap carries — the host that sent it and the
/// conversation it is about.
public struct PushTarget: Equatable, Sendable {
    public let hostKey: String
    public let conversationId: UInt64

    public init?(hostKey: String?, conversationId: UInt64?) {
        guard let hostKey, !hostKey.isEmpty, let conversationId else { return nil }
        self.hostKey = hostKey
        self.conversationId = conversationId
    }
}

/// What the pending tap does once the stored hosts and their connection
/// state are known.
public enum PushTargetAction: Equatable, Sendable {
    /// The host is no longer paired — nothing to open.
    case drop
    /// The right host is selected but has not finished connecting and
    /// loading its conversations.
    case wait
    case switchHost(String)
    case open(UInt64)
}

public func pushTargetAction(
    _ target: PushTarget,
    storedHostKeys: Set<String>,
    currentHostKey: String?,
    hostReady: Bool
) -> PushTargetAction {
    guard storedHostKeys.contains(target.hostKey) else { return .drop }
    guard target.hostKey == currentHostKey else { return .switchHost(target.hostKey) }
    guard hostReady else { return .wait }
    return .open(target.conversationId)
}
