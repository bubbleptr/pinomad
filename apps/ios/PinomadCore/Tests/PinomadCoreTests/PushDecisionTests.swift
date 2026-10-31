import Foundation
import Testing
@testable import PinomadCore

/// Push decisions kept out of the system callbacks (ADR-0025 §9): when to
/// register or clear this device, when a foreground banner is for another
/// host, and what a tapped notification should do next.
@Suite struct PushDecisionTests {
    @Test func registrationIsDrivenByTheSwitchAndTheRegistrationFlag() {
        let token = "aabbccdd"
        // Nothing was ever registered and the switch is off: no pointless
        // commit on the host.
        #expect(pushRegistrationAction(
            enabled: false, mayHaveRegistration: false, hostMinor: 9,
            deviceToken: token, environment: .development
        ) == .none)
        // The switch was turned off while offline: the flag still needs a
        // clear on the next connection.
        #expect(pushRegistrationAction(
            enabled: false, mayHaveRegistration: true, hostMinor: 9,
            deviceToken: token, environment: .development
        ) == .unregister)
        // Clearing is a 5.7 call — older hosts would not know it.
        #expect(pushRegistrationAction(
            enabled: false, mayHaveRegistration: true, hostMinor: 7,
            deviceToken: token, environment: .development
        ) == .unregister)
        #expect(pushRegistrationAction(
            enabled: false, mayHaveRegistration: true, hostMinor: 6,
            deviceToken: token, environment: .development
        ) == .none)
        // The APNs object form needs 5.9; a 5.8 host must never receive it.
        #expect(pushRegistrationAction(
            enabled: true, mayHaveRegistration: false, hostMinor: 8,
            deviceToken: token, environment: .production
        ) == .none)
        // Registration waits for APNs to hand the app a token.
        #expect(pushRegistrationAction(
            enabled: true, mayHaveRegistration: false, hostMinor: 9,
            deviceToken: nil, environment: .production
        ) == .none)
        #expect(pushRegistrationAction(
            enabled: true, mayHaveRegistration: true, hostMinor: 9,
            deviceToken: "", environment: .production
        ) == .none)
        #expect(pushRegistrationAction(
            enabled: true, mayHaveRegistration: false, hostMinor: 9,
            deviceToken: token, environment: .production
        ) == .register(ApnsPushToken(apns: token, environment: .production)))
    }

    @Test func serverRegistrationFollowsTheSwitchWhileSignedIn() {
        let server = "https://pinomad.si"
        let token = "aabbccdd"
        let current = ApnsPushToken(apns: token, environment: .production)
        // Signed out: the server has no session to record it under.
        #expect(serverPushAction(
            enabled: true, serverOrigin: nil, deviceToken: token,
            environment: .production, recorded: nil
        ) == .none)
        // Every occasion re-sends while on, so the record never ages out.
        #expect(serverPushAction(
            enabled: true, serverOrigin: server, deviceToken: token,
            environment: .production,
            recorded: ServerPushRegistration(serverOrigin: server, token: current)
        ) == .register(current))
        #expect(serverPushAction(
            enabled: true, serverOrigin: server, deviceToken: nil,
            environment: .production, recorded: nil
        ) == .none)
    }

    @Test func serverRemovalTargetsWhatWasRecordedOnThatServer() {
        let server = "https://pinomad.si"
        let old = ApnsPushToken(apns: "0011", environment: .development)
        let recorded = ServerPushRegistration(serverOrigin: server, token: old)
        // The switch went off (or the reader is signing out): remove the
        // token that was sent, even if APNs has issued a new one since.
        #expect(serverPushAction(
            enabled: false, serverOrigin: server, deviceToken: "aabb",
            environment: .production, recorded: recorded
        ) == .remove(old))
        // Nothing was ever sent: no request at all.
        #expect(serverPushAction(
            enabled: false, serverOrigin: server, deviceToken: "aabb",
            environment: .production, recorded: nil
        ) == .none)
        // A record from another server can't be removed with this session.
        #expect(serverPushAction(
            enabled: false, serverOrigin: "https://self.example", deviceToken: "aabb",
            environment: .production, recorded: recorded
        ) == .none)
        #expect(serverPushAction(
            enabled: false, serverOrigin: nil, deviceToken: "aabb",
            environment: .production, recorded: recorded
        ) == .none)
    }

    @Test func aServerRegistrationSurvivesARoundTripThroughDefaults() throws {
        let recorded = ServerPushRegistration(
            serverOrigin: "https://pinomad.si",
            token: ApnsPushToken(apns: "aabb", environment: .development))
        let data = try JSONEncoder().encode(recorded)
        #expect(try JSONDecoder().decode(ServerPushRegistration.self, from: data) == recorded)
    }

    @Test func foregroundBannerIsSuppressedOnlyForTheVisibleConversation() {
        let visible = ConversationRef(hostKey: "home", conversationId: 7)
        #expect(!shouldPresentPushBanner(
            pushHostKey: "home", pushConversationId: 7, visible: visible))
        // Another conversation on the same host is not on screen — show it.
        #expect(shouldPresentPushBanner(
            pushHostKey: "home", pushConversationId: 8, visible: visible))
        #expect(shouldPresentPushBanner(
            pushHostKey: "office", pushConversationId: 7, visible: visible))
        #expect(shouldPresentPushBanner(
            pushHostKey: "office", pushConversationId: 7, visible: nil))
        // No host in the payload is not this host — show it.
        #expect(shouldPresentPushBanner(
            pushHostKey: nil, pushConversationId: 7, visible: visible))
    }

    @Test func tappedNotificationWaitsForItsHostThenOpensOnce() throws {
        let target = try #require(PushTarget(hostKey: "office", conversationId: 42))
        let ref = ConversationRef(hostKey: "office", conversationId: 42)
        #expect(pushTargetAction(target, storedHostKeys: ["home"], hostReady: true) == .drop)
        // Every host is connected at once (#429): a tap waits for its own
        // host without moving the screen, however the focus stands.
        #expect(pushTargetAction(target, storedHostKeys: ["home", "office"], hostReady: false) == .wait)
        #expect(pushTargetAction(target, storedHostKeys: ["home", "office"], hostReady: true) == .open(ref))
    }

    @Test func forgettingClearsExactlyWhenThisDeviceMayStillBeRegistered() {
        // The switch may be off after turning it off while offline; the
        // flag still says the host may hold the last registration.
        #expect(pushForgetPlan(
            mayHaveRegistration: true, canClear: true
        ) == .clearThenForget)
        #expect(pushForgetPlan(
            mayHaveRegistration: true, canClear: false
        ) == .forgetWithWarning)
        // Nothing was ever sent: a switch that is on (but the host too old,
        // no device token, or the app never connected) must not produce a
        // revocation warning.
        #expect(pushForgetPlan(
            mayHaveRegistration: false, canClear: true
        ) == .forget)
        #expect(pushForgetPlan(
            mayHaveRegistration: false, canClear: false
        ) == .forget)
    }

    @Test func aTargetNeedsBothPayloadFields() {
        #expect(PushTarget(hostKey: "home", conversationId: 7) == PushTarget(
            hostKey: "home", conversationId: 7))
        #expect(PushTarget(hostKey: nil, conversationId: 7) == nil)
        #expect(PushTarget(hostKey: "", conversationId: 7) == nil)
        #expect(PushTarget(hostKey: "home", conversationId: nil) == nil)
    }
}
