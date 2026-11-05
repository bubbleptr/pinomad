// Host-side upgrades (ADR-0043): check npm for a newer release, wait for the
// host to go idle, stop taking new work, install the exact version that was
// checked, and hand off to the service manager by exiting. Every effect —
// npm, the service state, the clock, the timers, the exit — is injected.
import type { AutoUpgradeMode, HostUpgrade, UpgradeBlocker, UpgradeWhen } from "@pinomad/protocol/upgrade.ts";
import { Published, type HostValue } from "../host-value.ts";

/** What npm says about the latest release. */
export interface Release {
  readonly version: string;
  /** Epoch milliseconds. */
  readonly publishedAt: number;
  /** The `pinomad.protocolMajor` of its package.json; absent before ADR-0043. */
  readonly protocolMajor?: number;
}

export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface HostUpgraderOptions {
  /** The running release. */
  readonly current: string;
  readonly protocolMajor: number;
  /** Why a client can't start the upgrade right now (ADR-0043 §4), re-read before each start. */
  blocked(): Promise<UpgradeBlocker | null>;
  latest(): Promise<Release>;
  install(version: string): Promise<InstallResult>;
  /** Exits so the service manager starts the new release; never returns in production. */
  restart(): void;
  /** Whether the task graph has live tasks — a pending question counts (ADR-0009 §5). */
  readonly busy: HostValue<boolean>;
  readonly mode: HostValue<AutoUpgradeMode>;
  now(): number;
  /** Runs `run` every `ms`; returns the stop. */
  every(ms: number, run: () => void): () => void;
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often auto mode looks at the conditions. */
export const AUTO_TICK_MS = 60 * 1000;
/** Auto mode installs only releases at least this old, so a bad one can be pulled first. */
export const AUTO_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** And only after this long without tasks, submissions or terminal output. */
export const AUTO_QUIET_MS = 15 * 60 * 1000;

const sameUpgrade = (a: HostUpgrade, b: HostUpgrade): boolean => JSON.stringify(a) === JSON.stringify(b);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** semver order on `x.y.z[-pre]`; a prerelease sorts before its release, prerelease tags compare as strings. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export class HostUpgrader implements HostValue<HostUpgrade> {
  readonly #options: HostUpgraderOptions;
  readonly #published: Published<HostUpgrade>;
  readonly #stops: (() => void)[] = [];
  #check: Promise<void> | undefined;
  /** The last time a task ran, a submission came in or a terminal printed. */
  #lastActivity: number;

  constructor(options: HostUpgraderOptions) {
    this.#options = options;
    this.#lastActivity = options.now();
    this.#published = new Published<HostUpgrade>(
      {
        current: options.current,
        available: null,
        blocked: null,
        phase: "idle",
        target: null,
        checking: false,
        checkedAt: null,
        checkError: null,
        failure: null,
      },
      sameUpgrade,
    );
  }

  get value(): HostUpgrade {
    return this.#published.value;
  }

  subscribe(listener: (value: HostUpgrade) => void): () => void {
    return this.#published.subscribe(listener);
  }

  /** The host refuses new agent work while this is set (`HOST_UPGRADING_ERROR`). */
  get installing(): boolean {
    return this.value.phase === "installing";
  }

  /** Reads the service state and starts the timers; the first check runs in the background. */
  async begin(): Promise<void> {
    const { busy, mode, every } = this.#options;
    this.#stops.push(
      busy.subscribe((value) => {
        this.touch();
        if (!value && this.value.phase === "waiting") void this.#install(this.value.target!);
      }),
      mode.subscribe((value) => {
        if (value !== "off") void this.check().catch(() => {});
      }),
      every(CHECK_INTERVAL_MS, () => void this.check().catch(() => {})),
      every(AUTO_TICK_MS, () => this.#autoTick()),
    );
    await this.#refreshBlocked();
    if (mode.value !== "off") void this.check().catch(() => {});
  }

  close(): void {
    for (const stop of this.#stops.splice(0)) stop();
  }

  /** A submission or terminal output: auto mode waits for quiet again. */
  touch(): void {
    this.#lastActivity = this.#options.now();
  }

  /** Asks npm now; one check at a time. */
  check(): Promise<void> {
    if (this.#options.mode.value === "off") return Promise.reject(new Error("Upgrade checks are off on this host"));
    this.#check ??= this.#runCheck().finally(() => {
      this.#check = undefined;
    });
    return this.#check;
  }

  async start(when: UpgradeWhen): Promise<void> {
    await this.#refreshBlocked();
    const { blocked, available, phase } = this.value;
    if (blocked !== null) throw new Error(`This host can't upgrade itself (${blocked})`);
    if (phase !== "idle") throw new Error("An upgrade is already in progress");
    if (available === null) throw new Error("No newer release");
    // Resolves once the upgrade started; progress is on the stream. #install
    // sets `installing` before its first await, so no new work slips in.
    if (when === "now" || !this.#options.busy.value) void this.#install(available.version);
    else this.#set({ phase: "waiting", target: available.version });
  }

  cancel(): void {
    if (this.value.phase === "installing") throw new Error("The upgrade is installing and can't be cancelled");
    if (this.value.phase === "waiting") this.#set({ phase: "idle", target: null });
  }

  async #runCheck(): Promise<void> {
    this.#set({ checking: true });
    try {
      const release = await this.#options.latest();
      const newer = compareVersions(release.version, this.#options.current) > 0;
      this.#set({
        checking: false,
        checkedAt: this.#options.now(),
        checkError: null,
        available: newer
          ? {
              version: release.version,
              publishedAt: release.publishedAt,
              crossesMajor: release.protocolMajor !== this.#options.protocolMajor,
            }
          : null,
      });
    } catch (error) {
      this.#set({ checking: false, checkedAt: this.#options.now(), checkError: message(error) });
      throw error;
    }
  }

  async #refreshBlocked(): Promise<void> {
    this.#set({ blocked: await this.#options.blocked() });
  }

  #autoTick(): void {
    const { mode, busy, now } = this.#options;
    const { available, blocked, phase, failure } = this.value;
    if (busy.value) this.touch();
    if (mode.value !== "auto" || phase !== "idle" || blocked !== null || available === null) return;
    if (available.crossesMajor || failure?.version === available.version) return;
    if (now() - available.publishedAt < AUTO_MIN_AGE_MS || now() - this.#lastActivity < AUTO_QUIET_MS) return;
    void this.start("idle").catch(() => {});
  }

  async #install(version: string): Promise<void> {
    this.#set({ phase: "installing", target: version });
    let result: InstallResult;
    try {
      result = await this.#options.install(version);
    } catch (error) {
      result = { ok: false, message: message(error) };
    }
    if (result.ok) {
      this.#options.restart();
      return;
    }
    this.#set({ phase: "idle", target: null, failure: { version, message: result.message } });
  }

  #set(patch: Partial<HostUpgrade>): void {
    this.#published.set({ ...this.value, ...patch });
  }
}
