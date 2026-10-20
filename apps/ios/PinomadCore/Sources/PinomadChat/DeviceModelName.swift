import Darwin
import Foundation

/// The model name registered with a host at pairing time.
///
/// The host lists devices by this name. A hardware model ("iPhone 17 Pro")
/// already tells two phones apart, while the user-assigned name would need an
/// extra entitlement and a rename UI (issue #211).
public enum DeviceModelName {
    /// Map a hardware model identifier (e.g. `iPhone18,1`) to Apple's
    /// marketing name. An unknown identifier stays raw — a future
    /// `iPhone19,1` is more useful than the generic "iPhone". An empty
    /// identifier falls back to `fallback`.
    public static func displayName(identifier: String, fallback: String) -> String {
        let identifier = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else { return fallback }
        return names[identifier] ?? identifier
    }

    /// The hardware model identifier for this process. A simulator's
    /// `uname` reports the host CPU (`arm64`), so prefer the runtime's
    /// `SIMULATOR_MODEL_IDENTIFIER`, which names the simulated phone.
    public static func currentIdentifier(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        machine: String? = nil
    ) -> String {
        if let simulated = environment["SIMULATOR_MODEL_IDENTIFIER"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !simulated.isEmpty {
            return simulated
        }
        return machine ?? machineIdentifier
    }

    /// `currentIdentifier`'s display name, with `fallback` for an empty
    /// identifier (the caller passes `UIDevice.current.model`).
    public static func currentDisplayName(
        fallback: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        machine: String? = nil
    ) -> String {
        displayName(
            identifier: currentIdentifier(environment: environment, machine: machine),
            fallback: fallback)
    }

    private static var machineIdentifier: String {
        var info = utsname()
        guard uname(&info) == 0 else { return "" }
        return withUnsafeBytes(of: info.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// Apple's marketing names for the identifiers in Xcode 27's
    /// CoreSimulator metadata (`xcrun simctl list devicetypes -j`). The
    /// supported range starts at the oldest iPhone that runs iOS 26
    /// (support.apple.com/123705) and reaches the current iPhone 18 Pro.
    /// Adding a model means adding a row here; an unknown one still works.
    private static let names: [String: String] = [
        "iPhone12,1": "iPhone 11",
        "iPhone12,3": "iPhone 11 Pro",
        "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone12,8": "iPhone SE (2nd generation)",
        "iPhone13,1": "iPhone 12 mini",
        "iPhone13,2": "iPhone 12",
        "iPhone13,3": "iPhone 12 Pro",
        "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,2": "iPhone 13 Pro",
        "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,4": "iPhone 13 mini",
        "iPhone14,5": "iPhone 13",
        "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14",
        "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro",
        "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15",
        "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro",
        "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,1": "iPhone 16 Pro",
        "iPhone17,2": "iPhone 16 Pro Max",
        "iPhone17,3": "iPhone 16",
        "iPhone17,4": "iPhone 16 Plus",
        "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro",
        "iPhone18,2": "iPhone 17 Pro Max",
        "iPhone18,3": "iPhone 17",
        "iPhone18,4": "iPhone Air",
        "iPhone18,5": "iPhone 17e",
        "iPhone19,2": "iPhone 18 Pro",
        "iPhone19,3": "iPhone 18 Pro Max",
    ]
}
