import Foundation
import Observation
import OSLog
import PinomadCore
import UIKit
import UserNotifications

/// The system-facing half of push (ADR-0025 §9): permission, APNs
/// registration, and the two notification callbacks. Session decisions stay
/// in `AppModel`; the payload, banner, and registration decisions are pure
/// functions in `PinomadCore`.
@MainActor
@Observable
final class PushCenter: NSObject, @MainActor UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    /// The APNs token as hex, kept across launches so a connection after a
    /// relaunch can register before APNs answers again.
    private(set) var deviceToken: String?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// The app-level switch: while on, every host this device connects to
    /// registers it, not just the one on screen.
    private(set) var isEnabled: Bool
    /// Why APNs registration failed, if it did.
    private(set) var registrationError: String?
    /// The conversation actually on screen. Only its own push is suppressed;
    /// another conversation on the same host, or any other host's push,
    /// still shows a banner (ADR-0035 §9).
    var visibleConversation: ConversationRef?

    /// A tap that arrived before `AppModel` started.
    private var pendingTarget: PushTarget?
    /// Set by `AppModel` once it can route taps and sync tokens.
    var onTarget: ((PushTarget) -> Void)?
    var onToken: (() -> Void)?

    private let defaults = UserDefaults.standard
    private let tokenKey = "push.apnsToken"
    private let enabledKey = "push.enabled"
    private let legacyEnabledPrefix = "push.enabled."
    private let registeredPrefix = "push.registered."
    private let serverRegistrationKey = "push.serverRegistration"
    private let logger = Logger(subsystem: "build.kieran.pinomad", category: "push")

    private override init() {
        isEnabled = false
        super.init()
        deviceToken = defaults.string(forKey: tokenKey)
        migrateEnabledFlag()
        isEnabled = defaults.bool(forKey: enabledKey)
    }

    /// Fold the old per-host switches into the app-level flag once. Any host
    /// that had push on keeps it on for every host; the old keys then go away.
    private func migrateEnabledFlag() {
        let legacyKeys = defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(legacyEnabledPrefix) }
        guard !legacyKeys.isEmpty else { return }
        if legacyKeys.contains(where: { defaults.bool(forKey: $0) }) {
            defaults.set(true, forKey: enabledKey)
        }
        for key in legacyKeys {
            defaults.removeObject(forKey: key)
        }
    }

    /// The environment the signed entitlement was built with. The Info.plist
    /// key and `aps-environment` both come from `PINOMAD_APS_ENVIRONMENT`,
    /// so this never guesses from Debug/Release (ADR-0025 §9).
    var environment: ApnsEnvironment {
        Bundle.main.object(forInfoDictionaryKey: "PinomadAPSEnvironment") as? String
            == "production" ? .production : .development
    }

    var isDenied: Bool { authorization == .denied }

    var canDeliver: Bool {
        switch authorization {
        case .authorized, .provisional, .ephemeral: true
        default: false
        }
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: enabledKey)
    }

    /// Whether this device may still be registered with the host. Turning
    /// the switch off while offline cannot clear the host, so the flag stays
    /// set and forgetting still asks the host (or warns).
    func mayHaveRegistration(for hostKey: String) -> Bool {
        defaults.bool(forKey: registeredPrefix + hostKey)
    }

    func setMayHaveRegistration(_ registered: Bool, for hostKey: String) {
        defaults.set(registered, forKey: registeredPrefix + hostKey)
    }

    /// Drop only this host's registration evidence; the app-level switch and
    /// the other hosts' flags stay.
    func forget(_ hostKey: String) {
        defaults.removeObject(forKey: registeredPrefix + hostKey)
    }

    /// What this device last asked the account server to record (ADR-0036),
    /// written before the request goes out so a lost answer still gets
    /// removed later.
    var serverRegistration: ServerPushRegistration? {
        defaults.data(forKey: serverRegistrationKey)
            .flatMap { try? JSONDecoder().decode(ServerPushRegistration.self, from: $0) }
    }

    func setServerRegistration(_ registration: ServerPushRegistration?) {
        if let registration, let data = try? JSONEncoder().encode(registration) {
            defaults.set(data, forKey: serverRegistrationKey)
        } else {
            defaults.removeObject(forKey: serverRegistrationKey)
        }
    }

    /// Read the current permission and refresh the APNs token when allowed.
    func bootstrap() async {
        await refreshAuthorization()
    }

    /// First time the reader turns the switch on.
    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])
            authorization = granted ? .authorized : .denied
            if granted {
                registerForRemoteNotifications()
            } else {
                await refreshAuthorization()
            }
        } catch {
            registrationError = error.localizedDescription
            await refreshAuthorization()
        }
    }

    /// Ask Apple again after returning from Settings, or when the switch is
    /// turned on after permission was already decided.
    func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        if canDeliver {
            registerForRemoteNotifications()
        }
    }

    func registerForRemoteNotifications() {
        guard canDeliver else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func receivedToken(_ data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        guard !hex.isEmpty else { return }
        deviceToken = hex
        defaults.set(hex, forKey: tokenKey)
        registrationError = nil
        logger.info("APNs token received (\(hex.count, privacy: .public) hex chars)")
        onToken?()
    }

    func failedToRegister(_ error: any Error) {
        registrationError = error.localizedDescription
        logger.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    /// The cold-start tap, consumed once `AppModel` is ready for it.
    func takePendingTarget() -> PushTarget? {
        defer { pendingTarget = nil }
        return pendingTarget
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let info = notification.request.content.userInfo
        let hostKey = info["hostKey"] as? String
        let conversationId = (info["conversationId"] as? NSNumber)?.uint64Value
            ?? (info["conversationId"] as? String).flatMap(UInt64.init)
        let show = shouldPresentPushBanner(
            pushHostKey: hostKey,
            pushConversationId: conversationId,
            visible: visibleConversation)
        completionHandler(show ? [.banner, .sound] : [])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let conversationId = (info["conversationId"] as? NSNumber)?.uint64Value
            ?? (info["conversationId"] as? String).flatMap(UInt64.init)
        if let target = PushTarget(
            hostKey: info["hostKey"] as? String, conversationId: conversationId
        ) {
            if let onTarget {
                onTarget(target)
            } else {
                pendingTarget = target
            }
        }
        completionHandler()
    }
}

/// Early delegate hookup: a notification tap on a cold launch reaches
/// `didReceive` before the SwiftUI scene's task runs.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = PushCenter.shared
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushCenter.shared.receivedToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        PushCenter.shared.failedToRegister(error)
    }
}
