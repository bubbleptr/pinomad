import { useEffect, useState, useSyncExternalStore } from "react";
import {
  connectRemoteDurable,
  ProtocolMismatchError,
  type RemoteDurable,
  type RemoteDurableOptions,
  UnauthorizedError,
} from "@pinomad/protocol/remote-durable.ts";
import { type FrameConnection, type FrameTransport, webSocketTransport } from "@pinomad/protocol/transport.ts";
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
 * A first connection must produce its first view within this many
 * milliseconds. A socket that accepts frames but never answers (packets out,
 * nothing back) would otherwise leave the client in "connecting" until the
 * browser's own connection timeout fires.
 */
export const FIRST_CONNECT_TIMEOUT_MS = 15_000;

export interface RemoteDurableSettings {
  /** Test seam: override the first-connect timeout. */
  readonly timeoutMs?: number;
  /** Test seam: replace the connect call itself. */
  readonly connect?: (options: RemoteDurableOptions) => Promise<RemoteDurable>;
}

/**
 * One connection per `key` for the component's lifetime; later losses are the
 * view's `connection`, not this state. `options` is read when `key` changes.
 * If the connection does not reach ready within `settings.timeoutMs`
 * (default 15s), it is closed and the state becomes `failed`.
 */
export function useRemoteDurable(
  options: RemoteDurableOptions,
  key: string,
  settings?: RemoteDurableSettings,
): RemoteState {
  const [state, setState] = useState<RemoteState>({ status: "connecting" });
  useEffect(() => {
    let opened: RemoteDurable | undefined;
    let cancelled = false;
    // Wrap the transport so every in-flight connection can be closed on
    // timeout or cleanup; `connectRemoteDurable` only exposes `close` once
    // ready has resolved.
    const inner = "transport" in options ? options.transport : webSocketTransport(options.url, options.token);
    const connections = new Set<FrameConnection>();
    const abort = (): void => {
      for (const connection of connections) connection.close();
      connections.clear();
    };
    const transport: FrameTransport = {
      label: inner.label,
      open(handlers) {
        const connection = inner.open(handlers);
        connections.add(connection);
        return {
          send: (data) => connection.send(data),
          close: () => {
            connections.delete(connection);
            connection.close();
          },
        };
      },
    };
    const connect = settings?.connect ?? connectRemoteDurable;
    const timeoutMs = settings?.timeoutMs ?? FIRST_CONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      cancelled = true;
      abort();
      setState({
        status: "failed",
        error: `No response from ${inner.label} within ${timeoutMs / 1000} seconds. Check that the host is running and that this device can reach it (same network, or Tailscale connected).`,
        unauthorized: false,
      });
    }, timeoutMs);
    connect({ reconnectDelayMs: { min: 200, max: 2000 }, ...options, transport }).then(
      (remote) => {
        clearTimeout(timer);
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
        clearTimeout(timer);
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
      clearTimeout(timer);
      abort();
      opened?.close();
    };
  }, [key]);
  return state;
}

export function useDurableView(remote: RemoteDurable): DurableView {
  return useSyncExternalStore(remote.view.subscribe, remote.view.current);
}
