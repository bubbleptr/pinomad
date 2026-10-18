import Foundation

/// The QR sheet's pure parts (ADR-0022 §7): the countdown and the loopback
/// rule. A 127.0.0.1 link only reaches clients on the host machine itself,
/// so the sheet hides the QR and shows the hint instead — the same rule as
/// the web Devices dialog.
public enum PairingCodeCopy {
    /// Whole seconds left, rounded up so "1" means up to a second remains.
    public static func remainingSeconds(expiresAt: Double, now: Date = Date()) -> Int {
        let remaining = Int(ceil((expiresAt - now.timeIntervalSince1970 * 1000) / 1000))
        return max(0, remaining)
    }

    public static func countdown(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// Only the exact 127.0.0.1 host is treated as loopback — the web
    /// devices dialog uses the same check. localhost and other loopback
    /// forms still show a QR.
    public static func isLoopback(_ url: String) -> Bool {
        URLComponents(string: url)?.host == "127.0.0.1"
    }
}
