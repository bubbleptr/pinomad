import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";

export const DEFAULT_HOST_URL = "ws://127.0.0.1:7420";

/** localStorage key holding this browser's paired device identity. */
export const DEVICE_KEY = "pinomad.device";

/** A validated stored device identity, or undefined. */
export function storedDevice(stored: string | null): { url: string; hostKey: string; privateKey: string } | undefined {
  if (stored === null) return undefined;
  try {
    const device = JSON.parse(stored) as { url?: unknown; hostKey?: unknown; privateKey?: unknown };
    if (typeof device.url !== "string" || typeof device.hostKey !== "string" || typeof device.privateKey !== "string") {
      return undefined;
    }
    if (fromBase64Url(device.hostKey).length !== 32 || fromBase64Url(device.privateKey).length !== 32) return undefined;
    return { url: device.url, hostKey: device.hostKey, privateKey: device.privateKey };
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
  | { readonly kind: "pair"; readonly url: string; readonly hostKey: string; readonly secret: string }
  | { readonly kind: "device"; readonly url: string; readonly hostKey: string; readonly privateKey: string };

/**
 * Resolve where to connect from the fragment and stored device identity.
 * The fragment wins: a QR link on an already-paired browser still pairs.
 */
export function resolveAddress(
  hash: string,
  location: { protocol: string; host: string },
  stored: string | null,
): ResolvedAddress | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (token !== null && token !== "") {
    return { kind: "token", url: params.get("url") ?? DEFAULT_HOST_URL, token };
  }
  const pair = params.get("pair");
  if (pair !== null) {
    // <hostKey>.<secret>, both base64url; the host key must be 32 bytes of X25519.
    const dot = pair.indexOf(".");
    if (dot <= 0 || pair.indexOf(".", dot + 1) !== -1) return undefined;
    const hostKey = pair.slice(0, dot);
    const secret = pair.slice(dot + 1);
    try {
      if (fromBase64Url(hostKey).length !== 32 || fromBase64Url(secret).length === 0) return undefined;
    } catch {
      return undefined;
    }
    const url = params.get("url") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
    return { kind: "pair", url, hostKey, secret };
  }
  if (hash.replace(/^#/, "") !== "") return undefined;
  const device = storedDevice(stored);
  return device === undefined ? undefined : { kind: "device", ...device };
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
