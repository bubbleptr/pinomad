import { useCallback, useSyncExternalStore } from "react";
import type { LocalHostBridge } from "./use-local-host.ts";

/** A one-time join token for this account, or the account's reason in words. */
export type MintToken = () => Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly message: string }>;

export type SetupPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "installing"; readonly lines: readonly string[] }
  | { readonly kind: "joining" }
  | {
      readonly kind: "failed";
      /** Where Try again picks up: a failed join needs no second install. */
      readonly step: "install" | "join";
      readonly message: string;
      readonly lines: readonly string[];
    };

/** `finished` counts setups that joined, so every view showing the run can re-read the host once one lands. */
export type SetupSnapshot = { readonly phase: SetupPhase; readonly finished: number };

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * Setting up this Mac (#501): main runs install.sh, then `pinomad up` with a
 * one-time join token, so nobody types a code. The token is minted only once
 * the install is done: it expires in minutes, the download may not. The run
 * outlives the view that started it (Settings closes, the first-host page
 * takes over), so it lives here, one per bridge, and views subscribe.
 */
export class SetupRun {
  #snapshot: SetupSnapshot = { phase: { kind: "idle" }, finished: 0 };
  #listeners = new Set<() => void>();
  #running: Promise<void> | undefined;
  readonly #bridge: LocalHostBridge;

  constructor(bridge: LocalHostBridge) {
    this.#bridge = bridge;
  }

  readonly snapshot = (): SetupSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(phase: SetupPhase, finished = this.#snapshot.finished): void {
    this.#snapshot = { phase, finished };
    for (const listener of this.#listeners) listener();
  }

  /** Starts a setup, or joins the one running. After a failed join it starts again from the join. */
  start(serverOrigin: string, mintToken: MintToken): Promise<void> {
    this.#running ??= this.#run(serverOrigin, mintToken).finally(() => (this.#running = undefined));
    return this.#running;
  }

  /** Stops the install; too late once it is joining, which takes seconds. */
  cancel(): void {
    if (this.#snapshot.phase.kind === "installing") void this.#bridge.cancelInstall();
  }

  async #run(serverOrigin: string, mintToken: MintToken): Promise<void> {
    const previous = this.#snapshot.phase;
    let lines: readonly string[] = previous.kind === "failed" && previous.step === "join" ? previous.lines : [];
    if (!(previous.kind === "failed" && previous.step === "join")) {
      this.#set({ kind: "installing", lines });
      const unsubscribe = this.#bridge.onSetupLines((next) => {
        lines = next;
        if (this.#snapshot.phase.kind === "installing") this.#set({ kind: "installing", lines });
      });
      const result = await this.#bridge
        .install()
        .catch((reason: unknown) => ({ outcome: "failed" as const, message: messageOf(reason) }))
        .finally(unsubscribe);
      if (result.outcome === "cancelled") return this.#set({ kind: "idle" });
      if (result.outcome === "failed") return this.#set({ kind: "failed", step: "install", message: result.message, lines });
    }
    this.#set({ kind: "joining" });
    const token = await mintToken().catch((reason: unknown) => ({ ok: false as const, message: messageOf(reason) }));
    if (!token.ok) return this.#set({ kind: "failed", step: "join", message: token.message, lines });
    const joined = await this.#bridge
      .join(serverOrigin, token.token)
      .catch((reason: unknown) => ({ ok: false as const, message: messageOf(reason) }));
    if (!joined.ok) return this.#set({ kind: "failed", step: "join", message: joined.message, lines });
    this.#set({ kind: "idle" }, this.#snapshot.finished + 1);
  }
}

const runs = new WeakMap<LocalHostBridge, SetupRun>();

/** The bridge's one setup run: the app has one bridge, each story and test its own. */
export function setupRunFor(bridge: LocalHostBridge): SetupRun {
  let run = runs.get(bridge);
  if (run === undefined) runs.set(bridge, (run = new SetupRun(bridge)));
  return run;
}

export function useSetupRun(bridge: LocalHostBridge): SetupSnapshot & {
  start: (serverOrigin: string, mintToken: MintToken) => void;
  cancel: () => void;
} {
  const run = setupRunFor(bridge);
  const snapshot = useSyncExternalStore(run.subscribe, run.snapshot);
  const start = useCallback((serverOrigin: string, mintToken: MintToken) => void run.start(serverOrigin, mintToken), [run]);
  const cancel = useCallback(() => run.cancel(), [run]);
  return { ...snapshot, start, cancel };
}
