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

    @Test func foregroundBannerIsOnlySuppressedForTheConnectedHost() {
        #expect(!shouldPresentPushBanner(pushHostKey: "home", currentHostKey: "home"))
        #expect(shouldPresentPushBanner(pushHostKey: "office", currentHostKey: "home"))
        #expect(shouldPresentPushBanner(pushHostKey: "office", currentHostKey: nil))
        // No host in the payload is not this host — show it.
        #expect(shouldPresentPushBanner(pushHostKey: nil, currentHostKey: "home"))
    }

    @Test func tappedNotificationWaitsForItsHostThenOpensOnce() throws {
        let target = try #require(PushTarget(hostKey: "office", conversationId: 42))
        #expect(pushTargetAction(
            target, storedHostKeys: ["home"], currentHostKey: "home", hostReady: true
        ) == .drop)
        #expect(pushTargetAction(
            target, storedHostKeys: ["home", "office"], currentHostKey: "home", hostReady: true
        ) == .switchHost("office"))
        #expect(pushTargetAction(
            target, storedHostKeys: ["home", "office"], currentHostKey: nil, hostReady: false
        ) == .switchHost("office"))
        // The host is selected but still connecting or syncing its list.
        #expect(pushTargetAction(
            target, storedHostKeys: ["home", "office"], currentHostKey: "office", hostReady: false
        ) == .wait)
        #expect(pushTargetAction(
            target, storedHostKeys: ["home", "office"], currentHostKey: "office", hostReady: true
        ) == .open(42))
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
