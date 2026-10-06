import { useEffect, useState, useSyncExternalStore } from "react";
import {
  connectRemoteDurable,
  ProtocolMismatchError,
  type RemoteDurable,
  type RemoteDurableOptions,
  UnauthorizedError,
} from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

export type RemoteState =
  | { readonly status: "connecting" }
  /**
   * `unauthorized` = the host rejected us with 4401 (not just unreachable).
   * `mismatch` = the host speaks a protocol this bundle doesn't; carries the
   * error so the host's version can key the reload-once guard.
   */
  | { readonly status: "failed"; readonly error: string; readonly unauthorized: boolean; readonly mismatch?: ProtocolMismatchError }
  | { readonly status: "ready"; readonly remote: RemoteDurable };

/**
 * One connection per `key` for the component's lifetime; later losses are the
 * view's `connection`, not this state. `options` is read when `key` changes.
 */
export function useRemoteDurable(options: RemoteDurableOptions, key: string): RemoteState {
  const [state, setState] = useState<RemoteState>({ status: "connecting" });
  useEffect(() => {
    let opened: RemoteDurable | undefined;
    let cancelled = false;
    connectRemoteDurable({ reconnectDelayMs: { min: 200, max: 2000 }, ...options }).then(
      (remote) => {
        if (cancelled) {
          remote.close();
          return;
        }
        opened = remote;
        // The live-state panel starts with the task graph open. Here and not in a
        // component effect, which StrictMode runs twice and would toggle it shut again.
        void remote.controller.toggleTasks();
        setState({ status: "ready", remote });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            unauthorized: error instanceof UnauthorizedError,
            ...(error instanceof ProtocolMismatchError ? { mismatch: error } : {}),
          });
      },
    );
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [key]);
  return state;
}

export function useDurableView(remote: RemoteDurable): DurableView {
  return useSyncExternalStore(remote.view.subscribe, remote.view.current);
}
