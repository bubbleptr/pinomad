// The host-side upgrade (ADR-0043): when it checks, when it installs, which
// version it installs, and what a failure leaves behind. npm, the clock, the
// timers and the exit are all injected; nothing here installs or exits.
import { describe, expect, it } from "vitest";
import type { AutoUpgradeMode, UpgradeBlocker } from "@pinomad/protocol/upgrade.ts";
import { HOST_UPGRADING_ERROR } from "@pinomad/protocol/upgrade.ts";
import { compareVersions, HostUpgrader, type Release } from "../src/upgrade/upgrader.ts";
import { Published } from "../src/host-value.ts";

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

interface Harness {
  readonly upgrader: HostUpgrader;
  readonly installs: string[];
  /** `upgrader.installing` as each install saw it while npm ran. */
  readonly installingDuring: boolean[];
  /** What `admit()` threw while npm ran. */
  readonly admitDuring: unknown[];
  readonly restarts: number[];
  readonly busy: Published<boolean>;
  readonly mode: Published<AutoUpgradeMode>;
  /** Runs every scheduled callback whose interval is `ms`. */
  fire(ms: number): Promise<void>;
  advance(ms: number): void;
  setRelease(release: Release): void;
  failInstalls(message: string | undefined): void;
  checks(): number;
}

function harness(options: {
  current?: string;
  release?: Release;
  blocked?: UpgradeBlocker | null;
  /** Replaces the service-state read, to hold it open. */
  blockedRead?: () => Promise<UpgradeBlocker | null>;
  mode?: AutoUpgradeMode;
  busy?: boolean;
} = {}): Harness {
  let now = T0;
  let release: Release = options.release ?? { version: "0.14.0", publishedAt: T0 - 10 * DAY, protocolMajor: 5 };
  let installFailure: string | undefined;
  let checks = 0;
  const installs: string[] = [];
  const installingDuring: boolean[] = [];
  const admitDuring: unknown[] = [];
  const restarts: number[] = [];
  const scheduled: { ms: number; run: () => void }[] = [];
  const busy = new Published(options.busy ?? false, (a, b) => a === b);
  const mode = new Published<AutoUpgradeMode>(options.mode ?? "notify", (a, b) => a === b);
  const upgrader = new HostUpgrader({
    current: options.current ?? "0.13.0",
    protocolMajor: 5,
    blocked: options.blockedRead ?? (async () => options.blocked ?? null),
    latest: async () => {
      checks++;
      return release;
    },
    install: async (version) => {
      installs.push(version);
      installingDuring.push(upgrader.installing);
      try {
        upgrader.admit()();
      } catch (error) {
        admitDuring.push((error as Error).message);
      }
      return installFailure === undefined ? { ok: true } : { ok: false, message: installFailure };
    },
    restart: () => restarts.push(now),
    busy,
    mode,
    now: () => now,
    every: (ms, run) => {
      const entry = { ms, run };
      scheduled.push(entry);
      return () => scheduled.splice(scheduled.indexOf(entry), 1);
    },
  });
  return {
    upgrader,
    installs,
    installingDuring,
    admitDuring,
    restarts,
    busy,
    mode,
    fire: async (ms) => {
      for (const entry of scheduled.filter((each) => each.ms === ms)) entry.run();
      await settle();
    },
    advance: (ms) => void (now += ms),
    setRelease: (next) => void (release = next),
    failInstalls: (message) => void (installFailure = message),
    checks: () => checks,
  };
}

const begin = async (h: Harness): Promise<void> => {
  await h.upgrader.begin();
  await settle();
};

/** Lets the upgrader's promise chains (check, install) run to the end. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("compareVersions", () => {
  it("orders numerically, with a prerelease before its release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.13.0", "0.13.1")).toBeLessThan(0);
  });
});

describe("HostUpgrader checks", () => {
  it("reports a newer release after the startup check", async () => {
    const h = harness();
    await begin(h);
    expect(h.upgrader.value).toMatchObject({
      current: "0.13.0",
      available: { version: "0.14.0", crossesMajor: false },
      blocked: null,
      phase: "idle",
      checkedAt: T0,
    });
  });

  it("reports nothing when the latest release is not newer", async () => {
    const h = harness({ release: { version: "0.13.0", publishedAt: T0, protocolMajor: 5 } });
    await begin(h);
    expect(h.upgrader.value.available).toBeNull();
  });

  it("treats a release without a protocol major as crossing majors", async () => {
    const h = harness({ release: { version: "0.14.0", publishedAt: T0 - 10 * DAY } });
    await begin(h);
    expect(h.upgrader.value.available?.crossesMajor).toBe(true);
  });

  it("never asks npm while the setting is off, and refuses a manual check", async () => {
    const h = harness({ mode: "off" });
    await begin(h);
    await h.fire(6 * 60 * MINUTE);
    expect(h.checks()).toBe(0);
    await expect(h.upgrader.check()).rejects.toThrow(/off/);
  });

  it("checks right away when the setting leaves off", async () => {
    const h = harness({ mode: "off" });
    await begin(h);
    h.mode.set("notify");
    await settle();
    expect(h.checks()).toBe(1);
  });

  it("keeps the last result and reports the error when a check fails", async () => {
    const h = harness();
    await begin(h);
    h.setRelease(undefined as unknown as Release);
    await h.upgrader.check().catch(() => {});
    expect(h.upgrader.value.available?.version).toBe("0.14.0");
    expect(h.upgrader.value.checkError).not.toBeNull();
  });
});

describe("HostUpgrader manual upgrades", () => {
  it("refuses to start when blocked", async () => {
    const h = harness({ blocked: "no-service" });
    await begin(h);
    expect(h.upgrader.value.blocked).toBe("no-service");
    await expect(h.upgrader.start("now")).rejects.toThrow();
    expect(h.installs).toEqual([]);
  });

  it("installs the checked version at once when idle, then restarts", async () => {
    const h = harness();
    await begin(h);
    await h.upgrader.start("idle");
    await settle();
    expect(h.installs).toEqual(["0.14.0"]);
    expect(h.restarts).toHaveLength(1);
  });

  it("waits for running tasks, refusing no work meanwhile, then installs", async () => {
    const h = harness({ busy: true });
    await begin(h);
    await h.upgrader.start("idle");
    expect(h.upgrader.value.phase).toBe("waiting");
    expect(h.upgrader.installing).toBe(false);
    h.busy.set(false);
    await settle();
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("installs the version it checked even if npm's latest moves while waiting", async () => {
    const h = harness({ busy: true });
    await begin(h);
    await h.upgrader.start("idle");
    h.setRelease({ version: "1.0.0", publishedAt: T0, protocolMajor: 6 });
    await h.fire(6 * 60 * MINUTE);
    h.busy.set(false);
    await settle();
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("cancels a wait", async () => {
    const h = harness({ busy: true });
    await begin(h);
    await h.upgrader.start("idle");
    h.upgrader.cancel();
    h.busy.set(false);
    await settle();
    expect(h.upgrader.value.phase).toBe("idle");
    expect(h.installs).toEqual([]);
  });

  it("installs now without waiting for tasks", async () => {
    const h = harness({ busy: true });
    await begin(h);
    await h.upgrader.start("now");
    await settle();
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("refuses work while installing and takes it again after a failure", async () => {
    const h = harness();
    await begin(h);
    h.failInstalls("npm ERR! 404");
    await h.upgrader.start("now");
    await settle();
    expect(h.installingDuring).toEqual([true]);
    expect(h.upgrader.installing).toBe(false);
    expect(h.upgrader.value).toMatchObject({ phase: "idle", failure: { version: "0.14.0", message: "npm ERR! 404" } });
    expect(h.restarts).toEqual([]);
  });

  it("counts a call still being admitted as busy, and resumes on the next tick", async () => {
    const h = harness();
    await begin(h);
    const release = h.upgrader.admit();
    await h.upgrader.start("idle");
    expect(h.upgrader.value.phase).toBe("waiting");
    await h.fire(MINUTE);
    expect(h.installs).toEqual([]);
    release();
    await h.fire(MINUTE);
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("refuses to admit work while installing", async () => {
    const h = harness();
    await begin(h);
    h.failInstalls("boom");
    await h.upgrader.start("now");
    await settle();
    expect(h.admitDuring).toEqual([HOST_UPGRADING_ERROR]);
    expect(() => h.upgrader.admit()()).not.toThrow();
  });

  it("refuses to start with nothing newer", async () => {
    const h = harness({ release: { version: "0.13.0", publishedAt: T0, protocolMajor: 5 } });
    await begin(h);
    await expect(h.upgrader.start("now")).rejects.toThrow();
  });
});

describe("HostUpgrader auto mode", () => {
  const ready = async (options: Parameters<typeof harness>[0] = {}): Promise<Harness> => {
    const h = harness({ mode: "auto", ...options });
    await begin(h);
    h.advance(15 * MINUTE);
    return h;
  };

  it("upgrades a same-major release after 15 quiet minutes", async () => {
    const h = await ready();
    await h.fire(MINUTE);
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("does nothing in notify mode", async () => {
    const h = await ready({ mode: "notify" });
    await h.fire(MINUTE);
    expect(h.installs).toEqual([]);
  });

  it("never crosses a protocol major", async () => {
    const h = await ready({ release: { version: "1.0.0", publishedAt: T0 - 10 * DAY, protocolMajor: 6 } });
    await h.fire(MINUTE);
    expect(h.installs).toEqual([]);
  });

  it("waits until the release is three days old", async () => {
    const h = await ready({ release: { version: "0.14.0", publishedAt: T0 - 2 * DAY, protocolMajor: 5 } });
    await h.fire(MINUTE);
    expect(h.installs).toEqual([]);
    h.advance(DAY);
    await h.fire(MINUTE);
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("waits for 15 minutes without tasks, submissions or terminal output", async () => {
    const h = await ready();
    h.busy.set(true);
    await h.fire(MINUTE);
    h.busy.set(false);
    h.advance(10 * MINUTE);
    await h.fire(MINUTE);
    h.upgrader.touch();
    h.advance(10 * MINUTE);
    await h.fire(MINUTE);
    expect(h.installs).toEqual([]);
    h.advance(5 * MINUTE);
    await h.fire(MINUTE);
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("does not retry a version that failed to install", async () => {
    const h = await ready();
    h.failInstalls("boom");
    await h.fire(MINUTE);
    h.advance(30 * MINUTE);
    await h.fire(MINUTE);
    expect(h.installs).toEqual(["0.14.0"]);
  });

  it("re-checks every condition after reading the service state", async () => {
    let open: (value: null) => void = () => {};
    let held = false;
    const h = harness({
      mode: "auto",
      blockedRead: () => (held ? new Promise((resolve) => (open = resolve)) : Promise.resolve(null)),
    });
    await begin(h);
    h.advance(15 * MINUTE);
    held = true;
    void h.fire(MINUTE);
    // A check lands while the tick waits: the new release crosses majors.
    h.setRelease({ version: "1.0.0", publishedAt: T0 - 10 * DAY, protocolMajor: 6 });
    await h.upgrader.check();
    open(null);
    await settle();
    expect(h.installs).toEqual([]);
  });

  it("leaves a blocked host alone", async () => {
    const h = await ready({ blocked: "source" });
    await h.fire(MINUTE);
    expect(h.installs).toEqual([]);
  });
});
