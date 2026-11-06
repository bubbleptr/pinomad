// Host upgrades started from a client (ADR-0043): the `upgrade` stream and
// the `autoUpgrade` setting, typed for the platform layer (upgrade.ts).

use crate::json::Json;

/// The `autoUpgrade` host setting (5.30): `Notify` only reports, `Auto` also
/// installs when the host is idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AutoUpgradeMode {
    Off,
    Notify,
    Auto,
}

impl AutoUpgradeMode {
    pub(crate) fn from_str(text: &str) -> Option<Self> {
        match text {
            "off" => Some(Self::Off),
            "notify" => Some(Self::Notify),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Notify => "notify",
            Self::Auto => "auto",
        }
    }
}

/// Why a client can't start the upgrade; the platform shows the command to
/// run on the host instead (ADR-0043 §4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum UpgradeBlocker {
    /// A source checkout or a non-global install: `bun run upgrade` there.
    Source,
    /// No service runs this host, so nothing would start it again.
    NoService,
    /// `pinomad service stop` turned it off.
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum UpgradePhase {
    Idle,
    /// Started for "when idle"; the host still has tasks. `CancelUpgrade` ends it.
    Waiting,
    /// npm runs and the host refuses new work; it exits once the install succeeds.
    Installing,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AvailableUpgrade {
    pub version: String,
    /// Epoch milliseconds.
    pub published_at: f64,
    /// Clients still on this protocol major can't connect after it.
    pub crosses_major: bool,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct UpgradeFailure {
    pub version: String,
    /// The end of npm's output.
    pub message: String,
    /// The `attempt` it belongs to.
    pub attempt: u64,
}

/// The `upgrade` host stream (upgrade.ts `HostUpgrade`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HostUpgradeState {
    /// The running release; `None` in a source checkout.
    pub current: Option<String>,
    pub available: Option<AvailableUpgrade>,
    /// Set when `StartUpgrade` would be refused.
    pub blocked: Option<UpgradeBlocker>,
    pub phase: UpgradePhase,
    /// The version `Waiting` or `Installing` is for.
    pub target: Option<String>,
    /// Upgrades started since the host started; a failure names its attempt.
    pub attempt: u64,
    pub checking: bool,
    /// When the last check finished, epoch milliseconds — a failed check too.
    pub checked_at: Option<f64>,
    pub check_error: Option<String>,
    pub failure: Option<UpgradeFailure>,
}

fn text(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(|s| s.to_string_lossy())
}

/// The view's `upgrade` value, typed — `null` (before the stream lands, or a
/// host older than 5.30) decodes to `None`; unknown blockers read as none.
pub(crate) fn upgrade_of(view: &Json) -> Option<HostUpgradeState> {
    let upgrade = view.get("upgrade").filter(|value| !matches!(value, Json::Null))?;
    let available = upgrade.get("available").filter(|value| !matches!(value, Json::Null)).and_then(|value| {
        Some(AvailableUpgrade {
            version: text(value, "version")?,
            published_at: value.get("publishedAt").and_then(Json::as_number).unwrap_or(0.0),
            crosses_major: !matches!(value.get("crossesMajor"), Some(Json::Bool(false))),
        })
    });
    let failure = upgrade.get("failure").filter(|value| !matches!(value, Json::Null)).and_then(|value| {
        Some(UpgradeFailure {
            version: text(value, "version")?,
            message: text(value, "message").unwrap_or_default(),
            attempt: value.get("attempt").and_then(Json::as_number).unwrap_or(0.0) as u64,
        })
    });
    let blocked = match text(upgrade, "blocked").as_deref() {
        Some("source") => Some(UpgradeBlocker::Source),
        Some("no-service") => Some(UpgradeBlocker::NoService),
        Some("stopped") => Some(UpgradeBlocker::Stopped),
        _ => None,
    };
    let phase = match text(upgrade, "phase").as_deref() {
        Some("waiting") => UpgradePhase::Waiting,
        Some("installing") => UpgradePhase::Installing,
        _ => UpgradePhase::Idle,
    };
    Some(HostUpgradeState {
        current: text(upgrade, "current"),
        available,
        blocked,
        phase,
        target: text(upgrade, "target"),
        attempt: upgrade.get("attempt").and_then(Json::as_number).unwrap_or(0.0) as u64,
        checking: matches!(upgrade.get("checking"), Some(Json::Bool(true))),
        checked_at: upgrade.get("checkedAt").and_then(Json::as_number),
        check_error: text(upgrade, "checkError"),
        failure,
    })
}

/// The settings stream's `autoUpgrade`; `None` on a host older than 5.30.
pub(crate) fn auto_upgrade_of(settings: &Json) -> Option<AutoUpgradeMode> {
    settings.get("autoUpgrade").and_then(Json::as_str).and_then(|s| AutoUpgradeMode::from_str(&s.to_string_lossy()))
}
