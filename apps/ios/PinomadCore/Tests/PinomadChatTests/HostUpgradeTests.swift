import Testing
@testable import PinomadChat
import PinomadCore

private let minute = 60_000.0
private let now = 1_800_000_000_000.0

private func upgrade(
    current: String? = "0.13.0",
    available: AvailableUpgrade? = nil,
    blocked: UpgradeBlocker? = nil,
    phase: UpgradePhase = .idle,
    target: String? = nil,
    checking: Bool = false,
    checkedAt: Double? = nil,
    checkError: String? = nil,
    failure: UpgradeFailure? = nil
) -> HostUpgradeState {
    HostUpgradeState(
        current: current, available: available, blocked: blocked, phase: phase, target: target,
        attempt: 0, checking: checking, checkedAt: checkedAt, checkError: checkError, failure: failure)
}

private let release = AvailableUpgrade(version: "0.14.0", publishedAt: now - 5 * minute, crossesMajor: false)

@Suite struct HostUpgradeSummaryTests {
    @Test func phasesNameTheTarget() {
        #expect(UpgradeSummary.text(upgrade(phase: .waiting, target: "0.14.0"), checksOff: false, now: now)
            == "Upgrading to pinomad 0.14.0 once running tasks finish.")
        #expect(UpgradeSummary.text(upgrade(phase: .installing, target: "0.14.0"), checksOff: false, now: now)
            == "Installing pinomad 0.14.0… The host restarts when it's done.")
    }

    @Test func availableReleaseSaysWhenItWasPublished() {
        #expect(UpgradeSummary.text(upgrade(available: release), checksOff: false, now: now)
            == "pinomad 0.14.0 is available, released 5m ago.")
    }

    /// A failed check moves `checkedAt` too: only a clean one says "Up to date".
    @Test func failedCheckIsNotUpToDate() {
        let failed = upgrade(checkedAt: now - minute, checkError: "npm ERR! network")
        #expect(UpgradeSummary.text(failed, checksOff: false, now: now) == "Unknown: the last check failed.")
        #expect(UpgradeSummary.text(upgrade(checkedAt: now - 5 * minute), checksOff: false, now: now)
            == "Up to date. Checked 5m ago.")
    }

    @Test func sourceCheckoutIsNeverChecked() {
        let source = upgrade(current: nil, blocked: .source)
        #expect(UpgradeSummary.text(source, checksOff: false, now: now) == "Releases aren't checked for a source checkout.")
    }

    @Test func uncheckedSaysWhetherChecksAreOff() {
        #expect(UpgradeSummary.text(upgrade(), checksOff: true, now: now) == "Release checks are off.")
        #expect(UpgradeSummary.text(upgrade(), checksOff: false, now: now) == "Not checked yet.")
    }
}

@Suite struct HostUpgradeControlsTests {
    @Test func startNeedsAnIdleUnblockedHostWithARelease() {
        #expect(UpgradeControls(upgrade(available: release), connected: true).canStart)
        #expect(!UpgradeControls(upgrade(available: release), connected: false).canStart)
        #expect(!UpgradeControls(upgrade(available: release, blocked: .noService), connected: true).canStart)
        #expect(!UpgradeControls(upgrade(available: release, phase: .waiting), connected: true).canStart)
        #expect(!UpgradeControls(upgrade(), connected: true).canStart)
    }

    /// A source checkout has no upgrader to ask; the blocker shows its command instead.
    @Test func checkNowIsHiddenForSourceAndWhileUpgrading() {
        #expect(UpgradeControls(upgrade(), connected: true).showsCheckNow)
        #expect(!UpgradeControls(upgrade(blocked: .source), connected: true).showsCheckNow)
        #expect(UpgradeControls(upgrade(blocked: .stopped), connected: true).showsCheckNow)
        #expect(!UpgradeControls(upgrade(phase: .installing), connected: true).showsCheckNow)
    }

    @Test func failureShowsOnlyOnceTheHostIsIdleAgain() {
        let failure = UpgradeFailure(version: "0.14.0", message: "E404", attempt: 1)
        #expect(UpgradeControls(upgrade(failure: failure), connected: true).showsFailure)
        #expect(!UpgradeControls(upgrade(phase: .waiting, failure: failure), connected: true).showsFailure)
    }
}

@Suite struct HostRestartTests {
    @Test func restartingWhileInstallingAndNotConnected() {
        let installing = upgrade(phase: .installing, target: "0.14.0")
        #expect(HostRestart.isRestarting(upgrade: installing, connection: .reconnecting))
        #expect(!HostRestart.isRestarting(upgrade: installing, connection: .connected))
        #expect(!HostRestart.isRestarting(upgrade: upgrade(phase: .waiting), connection: .reconnecting))
        #expect(!HostRestart.isRestarting(upgrade: nil, connection: .reconnecting))
    }

    /// The connection errors of an expected restart don't toast; other notices still do.
    @Test func restartMutesConnectionErrors() {
        let error = Notice(id: 1, level: "error", message: "Could not connect")
        let info = Notice(id: 2, level: "info", message: "Host renamed")
        #expect(!HostRestart.shows(error, restarting: true))
        #expect(HostRestart.shows(info, restarting: true))
        #expect(HostRestart.shows(error, restarting: false))
    }

    @Test func upgradingRefusalReadsAsAnInstruction() {
        #expect(hostRefusalText("Host is upgrading") == "The host is upgrading. Retry once it's back.")
        #expect(hostRefusalText("Model not found") == "Model not found")
    }
}
