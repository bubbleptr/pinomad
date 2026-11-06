import PinomadCore

// Settings → Upgrade (ADR-0043): the words and states the page derives from
// the host's `upgrade` stream, the same as the Web's host-upgrade-section.

/// The refusal agent work gets while the host installs (upgrade.ts `HOST_UPGRADING_ERROR`).
let hostUpgradingError = "Host is upgrading"

/// A host refusal in the reader's words; other text passes through.
public func hostRefusalText(_ message: String) -> String {
    message == hostUpgradingError ? "The host is upgrading. Retry once it's back." : message
}

/// "5m ago", "just now".
func ago(_ at: Double, now: Double) -> String {
    let compact = relativeTime(at: at, now: now)
    return compact == "now" ? "just now" : "\(compact) ago"
}

public enum UpgradeSummary {
    /// What the host runs or will run next, in one sentence.
    public static func text(_ upgrade: HostUpgradeState, checksOff: Bool, now: Double) -> String {
        let target = upgrade.target ?? ""
        switch upgrade.phase {
        case .waiting: return "Upgrading to pinomad \(target) once running tasks finish."
        case .installing: return "Installing pinomad \(target)… The host restarts when it's done."
        case .idle: break
        }
        if let available = upgrade.available {
            return "pinomad \(available.version) is available, released \(ago(available.publishedAt, now: now))."
        }
        if upgrade.blocked == .source { return "Releases aren't checked for a source checkout." }
        // `checkedAt` also moves on a failed check: only a successful one says "up to date".
        if upgrade.checkError != nil { return "Unknown: the last check failed." }
        if let checkedAt = upgrade.checkedAt { return "Up to date. Checked \(ago(checkedAt, now: now))." }
        return checksOff ? "Release checks are off." : "Not checked yet."
    }

    /// What to run on the host instead, and why the button isn't here (ADR-0043 §4).
    public static func blocked(_ blocker: UpgradeBlocker) -> (title: String, detail: String) {
        switch blocker {
        case .source:
            ("This host runs from a source checkout", "Upgrade it there with `bun run upgrade`.")
        case .noService:
            ("This host isn't running as a service",
             "Nothing would start it again after an upgrade. Run `pinomad upgrade` on the host.")
        case .stopped:
            ("This host's service is stopped",
             "Run `pinomad upgrade` on the host; the service stays off until you start it.")
        }
    }

    public static func autoDescription(_ mode: AutoUpgradeMode) -> String {
        switch mode {
        case .off: "The host never checks for new releases."
        case .notify: "The host checks every 6 hours and shows new releases here."
        case .auto: "The host also installs a release once it's 3 days old and the host has been idle for 15 minutes. It never installs one that older apps can't connect to."
        }
    }
}

/// Which actions the page offers for the host's current upgrade state.
public struct UpgradeControls: Equatable {
    public let canStart: Bool
    /// Off while waiting or installing, and for a source checkout, which has no upgrader to ask.
    public let showsCheckNow: Bool
    public let showsCancel: Bool
    /// A failure is old news once another attempt runs.
    public let showsFailure: Bool

    public init(_ upgrade: HostUpgradeState, connected: Bool) {
        let idle = upgrade.phase == .idle
        canStart = connected && upgrade.blocked == nil && idle && upgrade.available != nil
        showsCheckNow = idle && upgrade.blocked != .source
        showsCancel = upgrade.phase == .waiting
        showsFailure = idle && upgrade.failure != nil
    }
}

/// The host going away to start its new release (ADR-0043 §2): the
/// connection drops while the last `upgrade` value still says installing.
public enum HostRestart {
    public static func isRestarting(upgrade: HostUpgradeState?, connection: ConnectionState) -> Bool {
        upgrade?.phase == .installing && connection == .reconnecting
    }

    /// Connection errors are expected during a restart; everything else still shows.
    public static func shows(_ notice: Notice, restarting: Bool) -> Bool {
        !(restarting && notice.level == "error")
    }
}
