// Host upgrades started from a client (5.30, ADR-0043). The host checks npm
// for a newer release, waits until it is idle, stops taking new work,
// installs the exact version it checked and exits for the service manager to
// start it again.

/** The `autoUpgrade` host setting: `notify` only reports, `auto` also upgrades when idle (ADR-0043 §6). */
export type AutoUpgradeMode = "off" | "notify" | "auto";

export const AUTO_UPGRADE_MODES = ["off", "notify", "auto"] as const satisfies readonly AutoUpgradeMode[];

export const isAutoUpgradeMode = (value: unknown): value is AutoUpgradeMode =>
  (AUTO_UPGRADE_MODES as readonly unknown[]).includes(value);

/**
 * Why a client cannot start the upgrade (ADR-0043 §4); the client shows the
 * command to run on the host instead. `source`: a source checkout or a
 * non-global install. `no-service`: no service runs this host, so nothing
 * would start it again. `stopped`: `pinomad service stop` turned it off.
 */
export type UpgradeBlocker = "source" | "no-service" | "stopped";

export interface AvailableUpgrade {
  readonly version: string;
  /** When npm published it, epoch milliseconds. */
  readonly publishedAt: number;
  /**
   * Its protocol major differs from this host's, or it does not declare one:
   * clients still on this major cannot connect after it (ADR-0043 §6, §8).
   */
  readonly crossesMajor: boolean;
}

/**
 * `idle`: nothing in progress. `waiting`: started for "when idle" and the
 * host still has tasks; `cancelUpgrade` ends it. `installing`: the host
 * refuses new work (`HOST_UPGRADING_ERROR`) and npm runs; it exits once the
 * install succeeds, or goes back to `idle` with a `failure`.
 */
export type UpgradePhase = "idle" | "waiting" | "installing";

/** The `upgrade` host stream (5.30). */
export interface HostUpgrade {
  /** The running release; `null` in a source checkout. */
  readonly current: string | null;
  /** A newer release than `current`; `null` when there is none or it is unknown. */
  readonly available: AvailableUpgrade | null;
  /** Set when `startUpgrade` would be refused. */
  readonly blocked: UpgradeBlocker | null;
  readonly phase: UpgradePhase;
  /** The version `waiting` or `installing` is for. */
  readonly target: string | null;
  /** A check against npm is running. */
  readonly checking: boolean;
  /** When the last check finished, epoch milliseconds; `null` before the first. */
  readonly checkedAt: number | null;
  /** Why the last check failed; cleared by the next successful one. */
  readonly checkError: string | null;
  /** The last failed install: its version and the end of npm's output. Auto-upgrade skips that version. */
  readonly failure: { readonly version: string; readonly message: string } | null;
}

/** The `ok:false` error of a call that starts agent work while the host is installing an upgrade. */
export const HOST_UPGRADING_ERROR = "Host is upgrading";

/** `startUpgrade`'s `when`: wait for running tasks to end, or stop taking work now. */
export type UpgradeWhen = "idle" | "now";
