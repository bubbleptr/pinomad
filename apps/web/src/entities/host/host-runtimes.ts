// Per-host connection state for the sidebar and the future machine list
// (ADR-0035 §4). The runtime table itself stays in the composition root; this
// registry only publishes what the UI may observe.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { ProtocolMismatchError, RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

export type ConnectionStatus = "connecting" | "connected" | "offline" | "terminal";
export type TerminalReason = "protocol_mismatch" | "rejected" | "closed";

export type HostRuntimeInfo =
  | {
      readonly phase: "connecting";
      readonly retry: () => void;
    }
  | {
      readonly phase: "failed";
      readonly error: string;
      readonly unauthorized: boolean;
      readonly mismatch?: ProtocolMismatchError;
      readonly retry: () => void;
    }
  | {
      readonly phase: "ready";
      readonly remote: RemoteDurable;
      readonly view: DurableView;
      readonly retry: () => void;
    };

export function connectionStatus(info: HostRuntimeInfo | undefined): ConnectionStatus {
  if (info === undefined) return "connecting";
  if (info.phase === "connecting") return "connecting";
  if (info.phase === "failed") {
    return info.mismatch === undefined && !info.unauthorized ? "offline" : "terminal";
  }
  if (info.view.connection === "connected") return "connected";
  if (info.view.connection === "reconnecting") return "offline";
  return "terminal";
}

export function terminalReason(info: HostRuntimeInfo | undefined): TerminalReason | undefined {
  if (info === undefined || connectionStatus(info) !== "terminal") return undefined;
  if (info.phase === "failed") return info.mismatch === undefined ? "rejected" : "protocol_mismatch";
  if (info.phase === "connecting") return undefined;
  if (info.view.connection === "outdated" || info.view.protocolMismatch !== undefined) return "protocol_mismatch";
  if (info.view.unauthorized === true) return "rejected";
  return "closed";
}

export class HostRuntimeRegistry {
  readonly #info = new Map<string, HostRuntimeInfo>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): number => this.#version;

  publish(hostKey: string, info: HostRuntimeInfo): void {
    this.#info.set(hostKey, info);
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  remove(hostKey: string): void {
    if (!this.#info.delete(hostKey)) return;
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  get(hostKey: string): HostRuntimeInfo | undefined {
    return this.#info.get(hostKey);
  }

  all(): ReadonlyMap<string, HostRuntimeInfo> {
    return this.#info;
  }
}

export function createHostRuntimeRegistry(): HostRuntimeRegistry {
  return new HostRuntimeRegistry();
}

export const HostRuntimesContext = createContext<HostRuntimeRegistry | undefined>(undefined);

function useRegistry(): HostRuntimeRegistry | undefined {
  return useContext(HostRuntimesContext);
}

/** Every host's latest runtime state; re-renders on any change. */
export function useHostRuntimeInfos(): ReadonlyMap<string, HostRuntimeInfo> {
  const registry = useRegistry();
  useSyncExternalStore(registry?.subscribe ?? (() => () => {}), registry?.snapshot ?? (() => 0));
  return registry?.all() ?? new Map();
}

export function useHostRuntimeInfo(hostKey: string): HostRuntimeInfo | undefined {
  const registry = useRegistry();
  useSyncExternalStore(registry?.subscribe ?? (() => () => {}), registry?.snapshot ?? (() => 0));
  return registry?.get(hostKey);
}

export function hostStatusText(info: HostRuntimeInfo | undefined): string {
  switch (connectionStatus(info)) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
    case "terminal": {
      const reason = terminalReason(info);
      return reason === "rejected"
        ? "Rejected by the host"
        : reason === "protocol_mismatch"
          ? "Protocol mismatch"
          : "Disconnected";
    }
  }
}
