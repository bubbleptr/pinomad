import PinomadCore

/// The connected machine's settings, edited from its settings pages.
/// All Command-class: a refusal lands as a notice, not a thrown error.
extension AppModel {
    /// This device's key as the host lists it, so the list can mark it.
    var thisDevicePublicKey: String? {
        sessionHost.flatMap { devicePublicKey(privateKey: $0.privateKey) }
    }

    /// Unpair another device from the connected host. This device's own
    /// pairing goes through `unpair(_:)`, which also forgets the host here.
    func revoke(device publicKey: String) {
        invokeSetting(.revokeDevice(publicKey: publicKey))
    }

    /// Rename the machine for every paired device; nil goes back to the
    /// machine's own name.
    func setHostName(_ name: String?) {
        invokeSetting(.setHostName(name: name))
    }

    func setAcceptAccountDevices(_ accept: Bool) {
        invokeSetting(.setAcceptAccountDevices(accept: accept))
    }

    /// The model new conversations start with; nil goes back to pi's.
    func setDefaultModel(_ model: ModelRef?) {
        invokeSetting(.setDefaultModel(model: model))
    }

    /// The thinking level new conversations start with; nil goes back to pi's.
    func setDefaultThinkingLevel(_ level: ThinkingLevel?) {
        invokeSetting(.setDefaultThinkingLevel(level: level))
    }

    /// How steer messages queued while the agent works are delivered; nil
    /// goes back to pi's.
    func setSteeringMode(_ mode: QueueDelivery?) {
        invokeSetting(.setSteeringMode(mode: mode))
    }

    /// How queued follow-up messages are delivered; nil goes back to pi's.
    func setFollowUpMode(_ mode: QueueDelivery?) {
        invokeSetting(.setFollowUpMode(mode: mode))
    }

    private func invokeSetting(_ call: FfiCall) {
        guard let session else { return }
        Task { _ = try? await session.invoke(call) }
    }
}
