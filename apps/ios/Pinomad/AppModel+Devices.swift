import PinomadCore

/// The connected machine's devices and name, edited from its settings page.
/// All Command-class: a refusal lands as a notice, not a thrown error.
extension AppModel {
    /// This device's key as the host lists it, so the list can mark it.
    var thisDevicePublicKey: String? {
        sessionHost.flatMap { devicePublicKey(privateKey: $0.privateKey) }
    }

    /// Unpair a device. Revoking this one ends the connection with 4401.
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

    private func invokeSetting(_ call: FfiCall) {
        guard let session else { return }
        Task { _ = try? await session.invoke(call) }
    }
}
