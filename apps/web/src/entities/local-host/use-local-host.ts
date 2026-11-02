import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge } from "../host/desktop-bridge.ts";
import type { LocalHostState } from "./local-host-protocol.ts";

export type LocalHostBridge = NonNullable<DesktopBridge["localHost"]>;

/** The bridge's switch over the host installed on this Mac; undefined in the browser and off macOS. */
export const localHostBridge = (): LocalHostBridge | undefined => window.pinomadDesktop?.localHost;

/**
 * The installed host's real state, read on mount, on `refresh()`, and when
 * the window regains focus — the user comes back from Terminal after
 * installing, or after `pinomad service` changed it there. `undefined` until
 * the first read lands.
 */
export function useLocalHostState(bridge: LocalHostBridge | undefined): {
  state: LocalHostState | undefined;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<LocalHostState>();
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

  return { state, refresh };
}
