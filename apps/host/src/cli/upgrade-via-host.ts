// `pinomad upgrade` as a client of the host's own upgrade (ADR-0043 §8): when
// the packaged service runs and answers, the CLI asks it to upgrade itself
// and prints the `upgrade` stream until the host goes away to restart.
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { HostUpgrade, UpgradeWhen } from "@pinomad/protocol/upgrade.ts";

export type FollowOutcome =
  /** The host closed the connection with the install done: it is restarting. */
  | { readonly kind: "restarting"; readonly version: string }
  | { readonly kind: "current"; readonly version: string | null }
  | { readonly kind: "failed"; readonly message: string };

/** The host's `upgrade` value once its snapshot arrived; undefined when the host predates the stream. */
export async function hostUpgrade(remote: RemoteDurable, timeoutMs = 5000): Promise<HostUpgrade | undefined> {
  const minor = remote.view.current().host?.protocol.minor ?? 0;
  if (minor < 30) return undefined;
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
 * Checks npm through the host, starts the upgrade and follows it. `cancel`
 * is set while the host waits for tasks, for the caller's Ctrl-C.
 */
export async function followUpgrade(
  remote: RemoteDurable,
  when: UpgradeWhen,
  log: (line: string) => void,
  onWaiting: (cancel: () => Promise<void>) => void = () => {},
): Promise<FollowOutcome> {
  await remote.controller.checkUpgrade();
  const checked = remote.view.current().upgrade;
  if (checked?.available === null || checked === null) return { kind: "current", version: checked?.current ?? null };
  const before = checked.failure;
  const version = checked.available.version;
  log(`upgrading the host to pinomad@${version}`);
  await remote.controller.startUpgrade(when);
  return new Promise((resolve) => {
    let phase: HostUpgrade["phase"] | undefined;
    let installed = false;
    const check = (): void => {
      const view = remote.view.current();
      if (view.connection !== "connected") {
        unsubscribe();
        resolve(installed ? { kind: "restarting", version } : { kind: "failed", message: "lost the host before the install finished" });
        return;
      }
      const value = view.upgrade;
      if (value === null) return;
      if (value.failure !== null && value.failure !== before && value.failure.version === version) {
        unsubscribe();
        resolve({ kind: "failed", message: value.failure.message });
        return;
      }
      if (value.phase === phase) return;
      phase = value.phase;
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
