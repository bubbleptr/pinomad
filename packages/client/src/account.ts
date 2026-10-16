// The server-accounts API (ADR-0022; docs/remote-access.md "服务端账号") as a
// client sees it: login/session ops, the account's host list, join tokens,
// and server-vouched pairing asks. Shared by web, desktop, and mobile, so it
// takes fetch as an injected minimal surface — DOM, undici, and Hermes all
// satisfy it — and never touches a DOM-only API.

import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { pairingFragment, parsePairParam } from "@pinomad/protocol/pairing-link.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { FrameConnection } from "@pinomad/protocol/transport.ts";
import type { StoredHost } from "./stored-host.ts";

/**
 * The slice of fetch the account client needs. DOM `fetch` and undici's are
 * both assignable here; on Hermes the app supplies the same shape.
 */
export interface AccountFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly signal?: AbortSignal;
}

export interface AccountFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type AccountFetch = (url: string, init?: AccountFetchInit) => Promise<AccountFetchResponse>;

const fallbackFetch = (url: string, init?: AccountFetchInit): Promise<AccountFetchResponse> =>
  // Wrapped, not referenced: some runtimes' fetch misbehaves unbound.
  fetch(url, init);

/**
 * An API failure the UI maps straight to copy. `code` is the server's `error`
 * verbatim — invalid_credentials, rate_limited, host_offline, host_too_old,
 * key_mismatch, disabled, not_joined, rebinding, host_timeout,
 * unauthenticated, accounts_disabled, not_found, and friends — plus two the
 * client invents: `network` when no usable answer arrived, and
 * `invalid_response` when a 2xx body didn't match the endpoint's shape.
 */
export interface AccountError {
  readonly code: string;
  readonly status?: number;
}

export type AccountResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AccountError };

const ok = <T>(value: T): AccountResult<T> => ({ ok: true, value });
const fail = (code: string, status?: number): { readonly ok: false; readonly error: AccountError } => ({
  ok: false,
  error: { code, ...(status === undefined ? {} : { status }) },
});

/** The session is gone (or was never there): time to log in again. */
export const isUnauthenticated = (error: AccountError): boolean => error.code === "unauthenticated";

/** Whether a server origin runs accounts. Same verdicts the host CLI uses. */
export type AccountsProbe = "enabled" | "disabled" | "unreachable";

/**
 * /api/me as the account probe: 401 means the API exists but wants a session;
 * a JSON user means a live session; a 404 (`accounts_disabled`, or an old
 * server with no /api) or an SPA's index.html means "no accounts". Anything
 * else — a proxy 502, a WAF 403 — is "unreachable": we can't tell.
 */
export async function probeAccounts(origin: string, fetchImpl: AccountFetch = fallbackFetch): Promise<AccountsProbe> {
  // AbortSignal.timeout isn't on Hermes; a controller plus setTimeout is.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5_000);
  let response: AccountFetchResponse;
  try {
    response = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/me`, { signal: timeout.signal });
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) return "enabled";
  if (response.status === 200) {
    const body = (await response.json().catch(() => undefined)) as { user?: unknown } | undefined;
    return typeof body?.user === "object" && body.user !== null ? "enabled" : "disabled";
  }
  return response.status === 404 ? "disabled" : "unreachable";
}

/**
 * Account traffic is TLS-only (ADR-0022): a plaintext join or login would hand
 * a bearer or one-use token to anyone on the path. Loopback http stays for
 * local development. Same rule as the host CLI's assertSecureServerOrigin.
 */
export function isSecureServerOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  const loopback = host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "::1" || host === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}

/**
 * An origin in canonical comparison form — `new URL().origin` strips trailing
 * slashes and default ports so "https://a.example/" and "https://a.example"
 * are the same server. Unparseable input survives verbatim.
 */
export function normalizeServerOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

/**
 * The credential form a client holds (ADR-0022 §2): ambient cookie, or a
 * bearer token — absent while logging in, when there is none yet.
 */
export type AccountCredentials = { readonly mode: "cookie" } | { readonly mode: "bearer"; readonly token?: string };

export interface AccountUser {
  readonly username: string;
}

export interface LoginSuccess {
  readonly user: AccountUser;
  readonly expiresAt: number;
  /** Present only in bearer mode — cookie-mode sessions never expose the token to JS. */
  readonly token?: string;
}

export interface JoinToken {
  readonly token: string;
  readonly expiresAt: number;
  /** The ready-to-show command for the "add a host" flow (`pinomad join …`). */
  readonly command: string;
}

/** One account-bound host row as GET /api/hosts reports it. */
export interface AccountHost {
  readonly hostId: string;
  readonly name: string;
  readonly noisePublicKey: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  /** Whether a pairing ask can go to this host right now (server-side verdict). */
  readonly pairing: "available" | "offline" | "host_too_old" | "key_mismatch";
}

/** The answer to POST /api/hosts/:hostId/pairing — the vouched one-time offer. */
export interface PairingOffer {
  readonly url: string;
  readonly hostKey: string;
  readonly secret: string;
  readonly expiresAt: number;
}

export interface AccountClient {
  /** The normalized origin every request targets. */
  readonly origin: string;
  login(username: string, password: string): Promise<AccountResult<LoginSuccess>>;
  me(): Promise<AccountResult<{ readonly user: AccountUser }>>;
  logout(): Promise<AccountResult<void>>;
  revokeAllSessions(): Promise<AccountResult<void>>;
  createJoinToken(): Promise<AccountResult<JoinToken>>;
  listHosts(): Promise<AccountResult<readonly AccountHost[]>>;
  requestPairing(hostId: string): Promise<AccountResult<PairingOffer>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const userBody = (value: unknown): { readonly user: AccountUser } | undefined => {
  if (!isRecord(value) || !isRecord(value.user) || typeof value.user.username !== "string") return undefined;
  return { user: { username: value.user.username } };
};

/**
 * A client for one server's account API. `credentials` picks how requests
 * authenticate: "cookie" sends `same-origin` credentials and relies on the
 * browser jar (mutating requests get the same-origin Origin header from the
 * fetch itself); "bearer" sets `Authorization: Bearer <token>` and needs no
 * ambient credential, so no Origin check applies server-side.
 */
export function createAccountClient(options: {
  readonly origin: string;
  readonly credentials: AccountCredentials;
  readonly fetch?: AccountFetch;
}): AccountClient {
  const fetchImpl = options.fetch ?? fallbackFetch;
  const origin = normalizeServerOrigin(options.origin);
  const bearer = options.credentials.mode === "bearer" ? options.credentials.token : undefined;
  const init: AccountFetchInit =
    options.credentials.mode === "cookie" ? { credentials: "same-origin" } : {};

  const request = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<AccountResult<unknown>> => {
    let response: AccountFetchResponse;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...init,
        method,
        headers: {
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail("network");
    }
    // 204s carry no body; json() on empty input throws, treated as absent.
    const json = await response.json().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return ok(json);
    const code = isRecord(json) && typeof json.error === "string" ? json.error : response.status === 401 ? "unauthenticated" : "unknown";
    return fail(code, response.status);
  };

  return {
    origin,
    login: async (username, password) => {
      const result = await request("/api/login", "POST", { username, password });
      if (!result.ok) return result;
      const base = userBody(result.value);
      if (base === undefined || !isRecord(result.value) || typeof result.value.expiresAt !== "number") {
        return fail("invalid_response");
      }
      const token = result.value.token;
      return ok({
        ...base,
        expiresAt: result.value.expiresAt,
        ...(typeof token === "string" ? { token } : {}),
      });
    },
    me: async () => {
      const result = await request("/api/me", "GET");
      if (!result.ok) return result;
      const value = userBody(result.value);
      return value === undefined ? fail("invalid_response") : ok(value);
    },
    logout: async () => {
      const result = await request("/api/logout", "POST");
      return result.ok ? ok(undefined) : result;
    },
    revokeAllSessions: async () => {
      const result = await request("/api/sessions/revoke-all", "POST");
      return result.ok ? ok(undefined) : result;
    },
    createJoinToken: async () => {
      const result = await request("/api/join-tokens", "POST");
      if (!result.ok) return result;
      const value = result.value;
      if (
        !isRecord(value) ||
        typeof value.token !== "string" ||
        typeof value.expiresAt !== "number" ||
        typeof value.command !== "string"
      ) {
        return fail("invalid_response");
      }
      return ok({ token: value.token, expiresAt: value.expiresAt, command: value.command });
    },
    listHosts: async () => {
      const result = await request("/api/hosts", "GET");
      if (!result.ok) return result;
      if (!Array.isArray(result.value)) return fail("invalid_response");
      const hosts: AccountHost[] = [];
      for (const entry of result.value) {
        if (
          !isRecord(entry) ||
          typeof entry.hostId !== "string" ||
          typeof entry.name !== "string" ||
          typeof entry.noisePublicKey !== "string" ||
          typeof entry.online !== "boolean" ||
          typeof entry.lastSeenAt !== "number" ||
          (entry.pairing !== "available" && entry.pairing !== "offline" && entry.pairing !== "host_too_old" && entry.pairing !== "key_mismatch")
        ) {
          return fail("invalid_response");
        }
        hosts.push({
          hostId: entry.hostId,
          name: entry.name,
          noisePublicKey: entry.noisePublicKey,
          online: entry.online,
          lastSeenAt: entry.lastSeenAt,
          pairing: entry.pairing,
        });
      }
      return ok(hosts);
    },
    requestPairing: async (hostId) => {
      const result = await request(`/api/hosts/${encodeURIComponent(hostId)}/pairing`, "POST");
      if (!result.ok) return result;
      const value = result.value;
      if (
        !isRecord(value) ||
        typeof value.url !== "string" ||
        typeof value.hostKey !== "string" ||
        typeof value.secret !== "string" ||
        typeof value.expiresAt !== "number"
      ) {
        return fail("invalid_response");
      }
      return ok({ url: value.url, hostKey: value.hostKey, secret: value.secret, expiresAt: value.expiresAt });
    },
  };
}

/**
 * A pairing offer as the fragment the existing flow reads — validated by the
 * same `pairingFragment` rule pasted links and deep links go through, so a
 * malformed offer is refused before a socket opens.
 */
export function accountPairingFragment(offer: PairingOffer): string | undefined {
  return pairingFragment(
    `https://server.invalid/#pair=${offer.hostKey}.${offer.secret}&url=${encodeURIComponent(offer.url)}`,
  );
}

/** How an account-bound host relates to the pairings this device stored. */
export type AccountHostStatus =
  /** A stored entry connects to it directly — either linked by account or sharing the Noise key. */
  | "paired"
  /** Nothing stored under it; an invite can be asked for (subject to `host.pairing`). */
  | "unpaired"
  /**
   * A stored entry links this serverOrigin+hostId but pins a different Noise
   * key: the host's key changed (reinstall, or worse). Report only — never
   * re-pair on the client's own initiative.
   */
  | "key_changed";

export interface AccountHostMatch {
  readonly host: AccountHost;
  readonly status: AccountHostStatus;
  /** The stored pairing behind a `paired`/`key_changed` verdict. */
  readonly stored?: StoredHost;
  /**
   * The stored entry shares the Noise key but was saved before account
   * linkage existed — the caller may persist `{...stored, account}` to adopt
   * the association. False when the match already carries the link.
   */
  readonly linkable: boolean;
}

/**
 * Pair the server's account hosts against the device's stored pairings.
 * Identity is the Noise key: a stored entry whose `account` link matches
 * serverOrigin+hostId is paired (or `key_changed` when the keys diverged);
 * an unlinked entry with the same key counts as paired and may adopt the link.
 */
export function matchAccountHosts(
  serverOrigin: string,
  hosts: readonly AccountHost[],
  stored: readonly StoredHost[],
): AccountHostMatch[] {
  const origin = normalizeServerOrigin(serverOrigin);
  return hosts.map((host) => {
    const linked = stored.find(
      (each) =>
        each.account !== undefined &&
        normalizeServerOrigin(each.account.serverOrigin) === origin &&
        each.account.hostId === host.hostId,
    );
    if (linked !== undefined) {
      return linked.hostKey === host.noisePublicKey
        ? { host, status: "paired" as const, stored: linked, linkable: false }
        : { host, status: "key_changed" as const, stored: linked, linkable: false };
    }
    const twin = stored.find((each) => each.hostKey === host.noisePublicKey);
    if (twin !== undefined) return { host, status: "paired" as const, stored: twin, linkable: twin.account === undefined };
    return { host, status: "unpaired" as const, linkable: false };
  });
}

/** What pairViaAccount's connect seam runs: one secure-channel handshake. */
export interface PairConnectArgs {
  readonly url: string;
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  readonly secret: string;
  readonly name: string;
}

/**
 * The real pairing path: the same IK handshake a QR link drives, minus the
 * durable session — the offer is spent and the device registered by the time
 * the handshake completes, so the socket closes right after `onPaired`.
 */
function pairHandshake(args: PairConnectArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    let connection: FrameConnection | undefined;
    const transport = secureWebSocketTransport({
      url: args.url,
      hostKey: args.hostKey,
      device: args.device,
      pairing: { secret: args.secret, name: args.name },
      onPaired: () => {
        resolve();
        connection?.close();
      },
    });
    connection = transport.open({
      message: () => {},
      // Settled already → no-op; before onPaired it's the refusal signal.
      closed: (code) => reject(new Error(`pairing connection closed (${code})`)),
    });
  });
}

/**
 * The whole "pair this account host" action: ask the server for a vouched
 * offer, normalize it through the pairing-link rule, run the IK handshake,
 * and hand back the StoredHost (with the account link) to persist. Pairing is
 * never retried implicitly — a refusal or dead socket is the caller's error.
 */
export async function pairViaAccount(
  client: AccountClient,
  hostId: string,
  name: string,
  connect: (args: PairConnectArgs) => Promise<void> = pairHandshake,
): Promise<AccountResult<StoredHost>> {
  const offer = await client.requestPairing(hostId);
  if (!offer.ok) return offer;
  const fragment = accountPairingFragment(offer.value);
  if (fragment === undefined) return fail("invalid_offer");
  const params = new URLSearchParams(fragment);
  const pair = parsePairParam(params.get("pair")!);
  const url = params.get("url");
  if (pair === undefined || url === null) return fail("invalid_offer");
  const device = generateKeyPair();
  try {
    await connect({ url, hostKey: fromBase64Url(pair.hostKey), device, secret: pair.secret, name });
  } catch {
    return fail("pair_rejected");
  }
  return ok({
    url,
    hostKey: pair.hostKey,
    privateKey: toBase64Url(device.privateKey),
    account: { serverOrigin: client.origin, hostId },
  });
}
