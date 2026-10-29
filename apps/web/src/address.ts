import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { pairingEndpointSet, parsePairParam } from "@pinomad/protocol/pairing-link.ts";
import { parseStoredHost, type StoredHost } from "@pinomad/client/stored-host.ts";
import type {} from "./entities/host/desktop-bridge.ts"; // brings in the window.pinomadDesktop global

export { pairingFragment } from "@pinomad/protocol/pairing-link.ts";
export type { StoredHost };

export const DEFAULT_HOST_URL = "ws://127.0.0.1:7420";

/** localStorage key holding this browser's paired device identity. */
export const DEVICE_KEY = "pinomad.device";

/** A validated stored device identity, or undefined. */
export function storedDevice(stored: string | null): StoredHost | undefined {
  if (stored === null) return undefined;
  try {
    return parseStoredHost(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

/**
 * How this tab may reach the host:
 * - `token`: the loopback gateway's shared secret (the printed link);
 * - `pair`: a QR's one-time offer — pair, then persist the device;
 * - `device`: this browser already paired; reconnect with its stored key.
 */
export type ResolvedAddress =
  | { readonly kind: "token"; readonly url: string; readonly token: string }
  | {
      readonly kind: "pair";
      readonly url: string;
      readonly hostKey: string;
      readonly secret: string;
      /** The invite's validated remote candidates; absent on old hosts/links. */
      readonly endpointSet?: EndpointSet;
    }
  | {
      readonly kind: "device";
      readonly url: string;
      readonly hostKey: string;
      readonly privateKey: string;
      readonly endpointSet?: EndpointSet;
    };

/**
 * Resolve a one-shot fragment against the paired hosts. The fragment wins: a
 * QR link on an already-paired browser still pairs. Without one, the focused
 * host (or the first stored host) supplies the legacy device address; the
 * multi-host app ignores that case and mounts every stored host instead.
 */
export function resolveAddress(
  hash: string,
  location: { protocol: string; host: string },
  hosts: readonly StoredHost[],
  focusedHostKey: string | null,
): ResolvedAddress | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (token !== null && token !== "") {
    return { kind: "token", url: params.get("url") ?? DEFAULT_HOST_URL, token };
  }
  const pair = params.get("pair");
  if (pair !== null) {
    const parsed = parsePairParam(pair);
    if (parsed === undefined) return undefined;
    // A scanned / page-fragment invite is validated by the same additive
    // endpointSet rule as a pasted or deep link; otherwise a bad set would
    // silently fall back to the legacy url here.
    const endpointSet = pairingEndpointSet(params);
    if (endpointSet === false) return undefined;
    const url = params.get("url") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
    return {
      kind: "pair",
      url,
      hostKey: parsed.hostKey,
      secret: parsed.secret,
      ...(endpointSet === undefined ? {} : { endpointSet }),
    };
  }
  if (hash.replace(/^#/, "") !== "") return undefined;
  const host = hosts.find((each) => each.hostKey === focusedHostKey) ?? hosts[0];
  return host === undefined ? undefined : { kind: "device", ...host };
}

/** Whether this page was served by the host it talks to — then a reload picks up a matching bundle. */
export function servedByHost(wsUrl: string, location: { host: string }): boolean {
  return new URL(wsUrl).host === location.host;
}

/** A human name for this browser, stored on the host as the device label. */
export function deviceName(userAgent: string): string {
  const os = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Mac/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : undefined;
  // Order matters: Edge and Chrome UAs also say Chrome/Safari.
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent) || /HeadlessChrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : undefined;
  const name = [os, browser].filter((part) => part !== undefined).join(" ");
  return name === "" ? "Browser" : name;
}

/**
 * The label this client registers on a host's device list. The desktop app's
 * bridge supplies a machine-aware name ("Mac Desktop (kieran-mbp)"); without
 * one — a browser tab, or a bridge that can't answer — the UA-derived name
 * stands, which is why the Electron UA stays untouched.
 */
export async function clientDeviceName(): Promise<string> {
  try {
    const named = await window.pinomadDesktop?.deviceName?.();
    if (typeof named === "string" && named !== "") return named;
  } catch {
    // A bridge that can't answer leaves the UA-derived name in place.
  }
  return deviceName(navigator.userAgent);
}
