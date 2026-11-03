/**
 * Wire contract for the desktop's "This Mac" host switch (#501).
 *
 * The app never runs a host itself (ADR-0003 §2, ADR-0017): main shells out
 * to the `pinomad` the user installed, and preload and the renderer share
 * only these serializable shapes and the push channel.
 */

export type LocalHostState =
  /** No `~/Library/LaunchAgents/pinomad.host.plist`: nothing to switch yet. */
  | { readonly kind: "not-installed" }
  /** The installed pinomad predates `service status --json`; `pinomad upgrade` fixes it. */
  | { readonly kind: "too-old" }
  | {
      readonly kind: "installed";
      readonly running: boolean;
      /** Turned off with `service stop`; stays off across logins. */
      readonly stopped: boolean;
      /** A stop this app started is still waiting for tasks; `followStop` joins it. */
      readonly stopping: boolean;
      /** The CLI's one-line description of the service. */
      readonly detail: string;
    }
  /** The CLI couldn't run at all (its Node is gone, say). */
  | { readonly kind: "error"; readonly message: string };

export type LocalHostResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type LocalHostStopResult =
  | { readonly outcome: "stopped" }
  /** Cancel killed the CLI while it waited for tasks: the service is still running. */
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "failed"; readonly message: string };

/** Main → renderer: every line `service stop` printed so far while it waits for running tasks, sent on each new one. */
export const localHostStopLinesChannel = "pinomad:localHost:stopLines";
