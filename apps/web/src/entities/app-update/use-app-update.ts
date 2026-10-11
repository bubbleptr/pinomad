import { useEffect, useState } from "react";
import type {} from "../host/desktop-bridge.ts"; // brings in the window.pinomadDesktop global
import type { UpdateStatus } from "./update-protocol.ts";

export type AppUpdate = {
  readonly status: UpdateStatus;
  check(): void;
  install(): void;
};

/**
 * The desktop updater's live status; `undefined` where the preload bridge is
 * absent (browser, older bridges without `updates`). The hook performs no
 * checks itself — reading and subscribing only.
 */
export function useAppUpdate(): AppUpdate | undefined {
  const updates = window.pinomadDesktop?.updates;
  const [status, setStatus] = useState<UpdateStatus>();

  useEffect(() => {
    if (updates === undefined) return;
    let live = true;
    void updates.status().then((initial) => {
      if (live) setStatus(initial);
    });
    const off = updates.onStatus((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [updates]);

  if (updates === undefined || status === undefined) return undefined;
  return {
    status,
    check: () => void updates.check(),
    install: () => void updates.install(),
  };
}
