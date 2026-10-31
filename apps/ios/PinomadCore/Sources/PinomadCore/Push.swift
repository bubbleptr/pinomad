import Foundation

/// What a push-registration opportunity should put on the wire. Kept as a
/// value so the app layer only maps it to `FfiCall.setPushToken`.
public enum PushRegistrationAction: Equatable, Sendable {
    /// Nothing to send: the host is too old, APNs has not issued a token
    /// yet, or the switch is off and nothing was ever registered.
    case none
    case register(ApnsPushToken)
    /// `setPushToken(null)`; a 5.7 host knows the call even though it does
    /// not know the APNs object form.
    case unregister
}

/// The action for one opportunity (connect, reconnect, foreground, or the
/// switch changing) — ADR-0025 §9. Registration needs both a 5.9 host and
/// a token; clearing only needs the 5.7 call, and only when this device may
/// still be registered — a switch that was never acted on is not a reason
/// to make the host commit a no-op clear.
public func pushRegistrationAction(
    enabled: Bool,
    mayHaveRegistration: Bool,
    hostMinor: UInt32,
    deviceToken: String?,
    environment: ApnsEnvironment
) -> PushRegistrationAction {
    guard hostSupportsCall(hostMinor: hostMinor, method: "setPushToken") else { return .none }
    if enabled {
        guard hostSupportsFeature(hostMinor: hostMinor, feature: .apnsPush),
              let deviceToken, !deviceToken.isEmpty
        else { return .none }
        return .register(ApnsPushToken(apns: deviceToken, environment: environment))
    }
    return mayHaveRegistration ? .unregister : .none
}

/// The signed-in account a server registration belongs to. The server
/// scopes removal to the caller's account, so the username matters as much
/// as the origin.
public struct ServerPushAccount: Codable, Equatable, Sendable {
    public let serverOrigin: String
    public let username: String

    public init(serverOrigin: String, username: String) {
        self.serverOrigin = serverOrigin
        self.username = username
    }
}

/// What this device last asked an account server to record (ADR-0036).
/// Kept so turning the switch off or signing out removes exactly that
/// token, even after APNs has issued a new one.
public struct ServerPushRegistration: Codable, Equatable, Sendable {
    public let account: ServerPushAccount
    public let apns: String
    public let production: Bool

    public init(account: ServerPushAccount, token: ApnsPushToken) {
        self.account = account
        apns = token.apns
        production = token.environment == .production
    }

    public var token: ApnsPushToken {
        ApnsPushToken(apns: apns, environment: production ? .production : .development)
    }
}

/// What a server-registration opportunity should send.
public enum ServerPushAction: Equatable, Sendable {
    case none
    /// `POST /api/push-tokens` — also refreshes the server's 90-day record.
    case register(ApnsPushToken)
    /// `POST /api/push-tokens/remove` for the recorded token.
    case remove(ApnsPushToken)
}

/// The account server's half of push (ADR-0036): the server only forwards
/// a host's push to a token recorded under the host's account, so while the
/// switch is on and a session exists, every occasion registers. Signing
/// out asks with `enabled: false`. Removal needs the account it was
/// recorded under: the server answers 204 to another account's removal
/// without touching the row, so a record from another account is kept until
/// that account signs in again, or it expires.
public func serverPushAction(
    enabled: Bool,
    account: ServerPushAccount?,
    deviceToken: String?,
    environment: ApnsEnvironment,
    recorded: ServerPushRegistration?
) -> ServerPushAction {
    guard let account else { return .none }
    if enabled {
        guard let deviceToken, !deviceToken.isEmpty else { return .none }
        return .register(ApnsPushToken(apns: deviceToken, environment: environment))
    }
    guard let recorded, recorded.account == account else { return .none }
    return .remove(recorded.token)
}

/// A foreground banner is suppressed only for the conversation visible on
/// screen right now; another conversation on the same host, or any push from
/// another host, still shows (ADR-0035 §9).
public func shouldPresentPushBanner(
    pushHostKey: String?,
    pushConversationId: UInt64?,
    visible: ConversationRef?
) -> Bool {
    guard let pushHostKey, let visible else { return true }
    return !(pushHostKey == visible.hostKey && pushConversationId == visible.conversationId)
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

/// What forgetting a host should do about its push registration. The flag
/// is set before a register and cleared only by a successful clear, so it
/// covers a switch turned off while offline as well as an in-flight register.
public enum PushForgetPlan: Equatable, Sendable {
    /// Nothing was registered — drop the pairing directly.
    case forget
    /// The host is connected and can take `setPushToken(null)`; clear first.
    case clearThenForget
    /// A registration may still exist but cannot be cleared now.
    case forgetWithWarning
}

public func pushForgetPlan(
    mayHaveRegistration: Bool,
    canClear: Bool
) -> PushForgetPlan {
    guard mayHaveRegistration else { return .forget }
    return canClear ? .clearThenForget : .forgetWithWarning
}

/// What the pending tap does once the stored hosts and their connection
/// state are known.
public enum PushTargetAction: Equatable, Sendable {
    /// The host is no longer paired — nothing to open.
    case drop
    /// The host has not finished connecting and loading its conversations.
    case wait
    case open(ConversationRef)
}

/// Decide a tap. Every paired host is already connected (#429), so the
/// focus plays no part: opening the conversation moves it. The pending tap
/// stays queued until that host is ready, so a slow connect neither drops
/// it nor moves the screen early.
public func pushTargetAction(
    _ target: PushTarget,
    storedHostKeys: Set<String>,
    hostReady: Bool
) -> PushTargetAction {
    guard storedHostKeys.contains(target.hostKey) else { return .drop }
    guard hostReady else { return .wait }
    return .open(ConversationRef(hostKey: target.hostKey, conversationId: target.conversationId))
}
