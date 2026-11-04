import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import type { LocalHostState } from "./local-host-protocol.ts";

export type LocalHostBridge = NonNullable<DesktopBridge["localHost"]>;

/** The bridge's switch over the host installed on this Mac; undefined in the browser and off macOS. */
export const localHostBridge = (): LocalHostBridge | undefined => window.pinomadDesktop?.localHost;

/** How long `pollUntilInstalled` keeps looking: `pinomad up` installs the service once the host has joined. */
const POLL_TIMEOUT_MS = 120_000;

/**
 * The installed host's real state, read on mount, on `refresh()`, and when
 * the window regains focus — the user comes back from a terminal after
 * installing, or after `pinomad service` changed it there. `undefined` until
 * the first read lands. `pollUntilInstalled()` re-reads every
 * `pollIntervalMs` until the service runs, for up to two minutes: a host
 * confirmed here installs while this window keeps the focus, and launchd
 * starts it a moment after its definition lands.
 */
export function useLocalHostState(
  bridge: LocalHostBridge | undefined,
  pollIntervalMs = 2000,
): {
  state: LocalHostState | undefined;
  refresh: () => Promise<void>;
  pollUntilInstalled: () => void;
} {
  const [state, setState] = useState<LocalHostState>();
  const [pollUntil, setPollUntil] = useState<number>();
  // Reads can overlap (focus during an action); only the latest one lands.
  const latest = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    const read = ++latest.current;
    let next: LocalHostState;
    try {
      next = await bridge.state();
    } catch (error) {
      next = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    if (read === latest.current) setState(next);
  }, [bridge]);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      // A read still in flight must not land after unmount.
      latest.current += 1;
    };
  }, [refresh]);

  // Each read lands a new state object, which schedules the next one.
  const installing = state?.kind === "not-installed" || (state?.kind === "installed" && !state.running && !state.stopped);
  useEffect(() => {
    if (pollUntil === undefined || !installing) return;
    if (Date.now() >= pollUntil) {
      setPollUntil(undefined);
      return;
    }
    const timer = setTimeout(() => void refresh(), pollIntervalMs);
    return () => clearTimeout(timer);
  }, [state, installing, pollUntil, pollIntervalMs, refresh]);

  const pollUntilInstalled = useCallback(() => setPollUntil(Date.now() + POLL_TIMEOUT_MS), []);

  return { state, refresh, pollUntilInstalled };
}
