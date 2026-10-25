import { useEffect, useState, useSyncExternalStore } from "react";
import {
  connectRemoteDurable,
  ProtocolMismatchError,
  type NetworkChanges,
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

/** Online/offline events restart a pending round or its backoff. */
const browserNetworkChanges: NetworkChanges = {
  subscribe(listener) {
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  },
};

/**
 * One connection per `key` for the component's lifetime; later losses are the
 * view's `connection`, not this state. `options` is read when `key` changes.
 * With a single transport, a connection that does not reach ready within
 * `settings.timeoutMs` (default 15s) is closed and the state becomes `failed`.
 * Candidate options carry their own per-stage and round deadlines, so the
 * coordinator reports the aggregate path diagnostics instead of a generic
 * outer timeout.
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
    // A new key is a new attempt: reset whatever the previous one settled on.
    setState({ status: "connecting" });
    const controller = new AbortController();
    const candidateMode = "candidates" in options;
    // Single-carrier options keep the outer deadline and the live-connection
    // wrapper below. Candidate options own their stage deadlines and close
    // every candidate themselves (including on abort).
    let inner: FrameTransport | undefined;
    let transport: FrameTransport | undefined;
    const connections = new Set<FrameConnection>();
    const abort = (): void => {
      for (const connection of connections) connection.close();
      connections.clear();
    };
    if (!candidateMode) {
      inner = "transport" in options ? options.transport : webSocketTransport(options.url, options.token);
      const source = inner;
      // Wrap the transport so every in-flight connection can be closed on
      // timeout or cleanup; `connectRemoteDurable` only exposes `close` once
      // ready has resolved. A connection leaves the set when the peer closes
      // it (the wrapped `closed` below) or when our close runs, so the set
      // holds only live connections — reconnects do not accumulate.
      transport = {
        label: source.label,
        open(handlers) {
          // `closed` may fire before `open` returns for transports that fail
          // synchronously; the guard keeps the delete valid either way.
          let connection: FrameConnection | undefined;
          connection = source.open({
            message: handlers.message,
            opened: handlers.opened,
            authenticated: handlers.authenticated,
            closed: (code, reason) => {
              if (connection !== undefined) connections.delete(connection);
              handlers.closed(code, reason);
            },
          });
          const live = connection;
          connections.add(live);
          return {
            send: (data) => live.send(data),
            close: () => {
              // Already out of the set means the peer closed it first — or we
              // already did — so there is nothing left to close.
              if (connections.delete(live)) live.close();
            },
          };
        },
      };
    }
    const connect = settings?.connect ?? connectRemoteDurable;
    const timeoutMs = settings?.timeoutMs ?? FIRST_CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!candidateMode && inner !== undefined) {
      const label = inner.label;
      timer = setTimeout(() => {
        cancelled = true;
        controller.abort();
        abort();
        setState({
          status: "failed",
          error: `No response from ${label} within ${timeoutMs / 1000} seconds. Check that the host is running and that this device can reach it (same network, or Tailscale connected).`,
          unauthorized: false,
        });
      }, timeoutMs);
    }
    const input: RemoteDurableOptions = candidateMode
      ? {
          ...(options as Extract<RemoteDurableOptions, { candidates: unknown }>),
          signal: controller.signal,
          network: options.network ?? browserNetworkChanges,
          ...(settings?.timeoutMs === undefined ? {} : { roundTimeoutMs: settings.timeoutMs }),
        }
      : {
          ...(options as Exclude<RemoteDurableOptions, { candidates: unknown }>),
          transport: transport!,
          signal: controller.signal,
          // A single carrier keeps the outer first-connect deadline above;
          // its coordinator still bounds every later reconnect stage.
          candidateTimeouts: {
            socketOpenMs: timeoutMs + 1_000,
            noiseMs: timeoutMs + 1_000,
            helloMs: timeoutMs + 1_000,
            syncMs: timeoutMs + 1_000,
          },
          roundTimeoutMs: timeoutMs + 1_000,
        };
    connect({ reconnectDelayMs: { min: 200, max: 2000 }, ...input }).then(
      (remote) => {
        if (timer !== undefined) clearTimeout(timer);
        if (cancelled) {
          remote.close();
          return;
        }
        opened = remote;
        setState({ status: "ready", remote });
      },
      (error: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
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
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      abort();
      opened?.close();
    };
  }, [key]);
  return state;
}

export function useDurableView(remote: RemoteDurable): DurableView {
  return useSyncExternalStore(remote.view.subscribe, remote.view.current);
}
