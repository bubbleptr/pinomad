// `pinomad upgrade` as a client of the host's own upgrade (ADR-0043 §8): when
// the packaged service runs and answers, the CLI asks it to upgrade itself
// and prints the `upgrade` stream until the host goes away to restart.
import { hostSupportsCall } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { HostUpgrade, UpgradeWhen } from "@pinomad/protocol/upgrade.ts";

export type FollowOutcome =
  /** The host closed the connection with the install done: it is restarting. */
  | { readonly kind: "restarting"; readonly version: string }
  | { readonly kind: "current"; readonly version: string | null }
  /** Another device cancelled the wait. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The host's `upgrade` value once its snapshot arrived; undefined when the host predates the stream. */
export async function hostUpgrade(remote: RemoteDurable, timeoutMs = 5000): Promise<HostUpgrade | undefined> {
  if (!hostSupportsCall(remote.view.current().host?.protocol.minor ?? 0, "startUpgrade")) return undefined;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref();
    const finish = (value: HostUpgrade | undefined): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const check = (): void => {
      const value = remote.view.current().upgrade;
      if (value !== null) finish(value);
    };
    const unsubscribe = remote.view.subscribe(check);
    check();
  });
}

/**
 * Upgrades through the host: checks npm there, starts the upgrade and
 * follows it. Undefined — upgrade locally instead — when the host predates
 * the stream, can't upgrade itself, or refuses the check (`autoUpgrade` is
 * off). Any later error is a failure: the host may be installing already, and
 * a second install into the same prefix must not start here. `onWaiting`
 * gets the cancel while the host waits for tasks, for the caller's Ctrl-C.
 */
export async function upgradeWithHost(
  remote: RemoteDurable,
  when: UpgradeWhen,
  log: (line: string) => void,
  onWaiting: (cancel: () => Promise<void>) => void = () => {},
): Promise<FollowOutcome | undefined> {
  const initial = await hostUpgrade(remote);
  if (initial === undefined || initial.blocked !== null) return undefined;
  if (initial.phase !== "idle") return { kind: "failed", message: `the host is already upgrading to pinomad@${initial.target ?? "?"}` };
  try {
    await remote.controller.checkUpgrade();
  } catch (error) {
    log(`the host won't check for releases (${message(error)}); upgrading here`);
    return undefined;
  }
  const checked = remote.view.current().upgrade;
  if (checked === null || checked.available === null) return { kind: "current", version: checked?.current ?? null };
  const version = checked.available.version;
  log(`upgrading the host to pinomad@${version}`);
  try {
    await remote.controller.startUpgrade(when);
  } catch (error) {
    return { kind: "failed", message: message(error) };
  }
  // The host bumps `attempt` before the call's result goes out, so this is ours.
  const attempt = remote.view.current().upgrade?.attempt;
  return new Promise((resolve) => {
    let phase: HostUpgrade["phase"] | undefined;
    let installed = false;
    const finish = (outcome: FollowOutcome): void => {
      unsubscribe();
      resolve(outcome);
    };
    const check = (): void => {
      const view = remote.view.current();
      if (view.connection !== "connected") {
        finish(installed ? { kind: "restarting", version } : { kind: "failed", message: "lost the host before the install finished" });
        return;
      }
      const value = view.upgrade;
      if (value === null) return;
      if (value.failure !== null && value.failure.attempt === attempt) {
        finish({ kind: "failed", message: value.failure.message });
        return;
      }
      if (value.phase === phase) return;
      phase = value.phase;
      if (phase === "idle") {
        finish({ kind: "cancelled" });
        return;
      }
      if (phase === "waiting") {
        log("waiting for running tasks to finish (Ctrl-C to cancel)");
        onWaiting(() => remote.controller.cancelUpgrade());
      }
      if (phase === "installing") {
        installed = true;
        log(`installing pinomad@${version}`);
      }
    };
    const unsubscribe = remote.view.subscribe(check);
    check();
  });
}
