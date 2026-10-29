// The server-accounts API (ADR-0022; apps/site/content/docs/remote-access.zh.md "服务端账号") as a
// client sees it: login/session ops, the account's host list, join tokens,
// and server-vouched pairing asks. Shared by web and desktop, so it
// takes fetch as an injected minimal surface — DOM and undici both
// satisfy it — and never touches a DOM-only API.

import { encodeEndpointSetParam, parseEndpointSet, type EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { UNAUTHORIZED_CLOSE_CODE } from "@pinomad/protocol/frames.ts";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { pairingFragment, parsePairParam } from "@pinomad/protocol/pairing-link.ts";
import {
  candidatePlan,
  preferredLegacyUrl,
  type RemoteCandidateRole,
} from "@pinomad/protocol/remote-candidates.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { FrameConnection } from "@pinomad/protocol/transport.ts";
import type { StoredHost } from "./stored-host.ts";

/**
 * The slice of fetch the account client needs. DOM `fetch` and undici's are
 * both assignable here; other runtimes can supply the same shape.
 */
export interface AccountFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly redirect?: "follow" | "error" | "manual";
  readonly signal?: AbortSignal;
}

export interface AccountFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
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
  /** Per-path evidence for an account pairing attempt; absent on other API errors. */
  readonly candidates?: readonly PairCandidateDiagnostic[];
}

/** Why one offered pairing candidate did not complete message 2. */
export type PairCandidateOutcome = "unsupported" | "rejected" | "unreachable" | "timeout";

export interface PairCandidateDiagnostic {
  readonly url: string;
  readonly role: RemoteCandidateRole;
  readonly outcome: PairCandidateOutcome;
  /** The close code when the host answered. */
  readonly code?: number;
  readonly reason?: string;
}

export type AccountResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AccountError };

const ok = <T>(value: T): AccountResult<T> => ({ ok: true, value });
const fail = (code: string, status?: number): { readonly ok: false; readonly error: AccountError } => ({
  ok: false,
  error: { code, ...(status === undefined ? {} : { status }) },
});

/**
 * Pairing failed on every path. Only a round whose every DIALED path was
 * rejected can be called `pair_rejected`; a single relay's unauthenticated
 * 4401 must not overwrite a timeout or unreachable direct. Unsupported paths
 * are never dialed and do not vote. The diagnostics keep every path's reason,
 * rejected ones included.
 */
const pairFailure = (candidates: readonly PairCandidateDiagnostic[]): {
  readonly ok: false;
  readonly error: AccountError;
} => {
  const dialed = candidates.filter((candidate) => candidate.outcome !== "unsupported");
  const allRejected = dialed.length > 0 && dialed.every((candidate) => candidate.outcome === "rejected");
  const any = (outcome: PairCandidateOutcome): boolean =>
    dialed.some((candidate) => candidate.outcome === outcome);
  const code = allRejected
    ? "pair_rejected"
    : any("timeout")
      ? "pair_timeout"
      : any("unreachable")
        ? "pair_unreachable"
        : candidates.some((candidate) => candidate.outcome === "unsupported")
          ? "pair_unsupported"
          : "pair_unreachable";
  return {
    ok: false,
    error: { code, ...(candidates.length === 0 ? {} : { candidates }) },
  };
};

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
  // An explicit controller plus setTimeout, not AbortSignal.timeout: the
  // timer stays armed through the body read — a stalled body after the
  // headers (a half-dead proxy) must still count as unreachable.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5_000);
  try {
    const response = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/me`, {
      signal: timeout.signal,
      redirect: "manual",
    });
    if (response.status === 401) return "enabled";
    if (response.status === 200) {
      // Read the body inside the timeout's reach: a stalled body (half-dead
      // proxy) is "unreachable", but a fully-read body that isn't JSON — an
      // SPA's index.html — is a plain "disabled".
      const text = await response.text();
      let body: { user?: unknown } | undefined;
      try {
        body = JSON.parse(text) as { user?: unknown };
      } catch {
        return "disabled";
      }
      return typeof body?.user === "object" && body.user !== null ? "enabled" : "disabled";
    }
    return response.status === 404 ? "disabled" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
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
  // The parser already canonicalized every IPv4 spelling (`127.1`, `0x7f.1`,
  // `2130706433`) to dotted form, so a strict quad match is an address check
  // — a `127.example.com` domain no longer slips through a string prefix.
  const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(host);
  const loopback =
    host === "localhost" || host.endsWith(".localhost") || ipv4Loopback || host === "::1" || host === "[::1]";
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
  /** Remote candidates forwarded additively by the server (ADR-0032); absent on older servers. */
  readonly endpointSet?: EndpointSet;
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
  // Never follow redirects: a 307 pointing at http:// would replay the
  // bearer or the login body in plaintext. "manual" surfaces the 3xx (undici)
  // or an opaque status-0 answer (DOM); an implementation that silently
  // ignores unknown init fields must refuse redirects in its own layer.
  const init: AccountFetchInit = {
    redirect: "manual",
    ...(options.credentials.mode === "cookie" ? { credentials: "same-origin" as const } : {}),
  };

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
    // An opaqueredirect (DOM `manual` mode) carries status 0 and no readable
    // target — a transport failure, not an API answer.
    if (response.status === 0) return fail("network");
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
      // A pairing invite with an explicit empty set is malformed (ADR-0032
      // §8); unknown schemas fall back to the legacy url, as on the host's
      // own pairing link.
      let endpointSet: EndpointSet | undefined;
      if (value.endpointSet !== undefined) {
        const parsed = parseEndpointSet(value.endpointSet);
        if (parsed.kind === "malformed") return fail("invalid_response");
        if (parsed.kind === "valid") {
          if (parsed.endpointSet.endpoints.length === 0) return fail("invalid_response");
          endpointSet = parsed.endpointSet;
        }
      }
      return ok({
        url: value.url,
        hostKey: value.hostKey,
        secret: value.secret,
        expiresAt: value.expiresAt,
        ...(endpointSet === undefined ? {} : { endpointSet }),
      });
    },
  };
}

/**
 * A pairing offer as the fragment the existing flow reads — validated by the
 * same `pairingFragment` rule pasted links and deep links go through, so a
 * malformed offer is refused before a socket opens.
 */
export function accountPairingFragment(offer: PairingOffer): string | undefined {
  const endpointSet =
    offer.endpointSet === undefined ? "" : `&endpointSet=${encodeEndpointSetParam(offer.endpointSet)}`;
  return pairingFragment(
    `https://server.invalid/#pair=${offer.hostKey}.${offer.secret}&url=${encodeURIComponent(offer.url)}${endpointSet}`,
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
  /**
   * Whether this client may register the host through the account without
   * asking the user (M8): only an unpaired host, outside the declined set,
   * when the local pairing list was actually read. A failed read is not an
   * empty list.
   */
  readonly autoRegister: boolean;
}

/**
 * One account-host identity: the server that vouches for it plus its hostId.
 * The declined set stores these so a forgotten or refused account host is not
 * silently registered again.
 */
export interface AccountHostRef {
  readonly serverOrigin: string;
  readonly hostId: string;
}

/**
 * Pair the server's account hosts against the device's stored pairings.
 * Identity is the Noise key: a stored entry whose `account` link matches
 * serverOrigin+hostId is paired (or `key_changed` when the keys diverged);
 * an unlinked entry with the same key counts as paired and may adopt the link.
 *
 * `declined` holds identities the user forgot or the host refused; `storedRead`
 * is false when the local pairing list could not be loaded, which must not be
 * mistaken for an empty list. Both only affect `autoRegister`: the verdict
 * still describes the pairing the client actually has.
 */
export function matchAccountHosts(
  serverOrigin: string,
  hosts: readonly AccountHost[],
  stored: readonly StoredHost[],
  declined: readonly AccountHostRef[],
  storedRead: boolean,
): AccountHostMatch[] {
  const origin = normalizeServerOrigin(serverOrigin);
  const declinedKeys = new Set(
    declined.map((entry) => `${normalizeServerOrigin(entry.serverOrigin)}\u0000${entry.hostId}`),
  );
  return hosts.map((host) => {
    const match = (status: AccountHostStatus, stored?: StoredHost, linkable = false): AccountHostMatch => ({
      host,
      status,
      ...(stored === undefined ? {} : { stored }),
      linkable,
      autoRegister:
        storedRead
        && status === "unpaired"
        && !declinedKeys.has(`${origin}\u0000${host.hostId}`),
    });
    // Several entries may share a link — an explicit re-pair after a key
    // change stores a fresh record without deleting the stale one. The entry
    // whose key still matches wins; only a link with no matching key at all
    // is a key_changed report.
    const linked = stored.filter(
      (each) =>
        each.account !== undefined &&
        normalizeServerOrigin(each.account.serverOrigin) === origin &&
        each.account.hostId === host.hostId,
    );
    const exact = linked.find((each) => each.hostKey === host.noisePublicKey);
    if (exact !== undefined) return match("paired", exact);
    if (linked.length > 0) return match("key_changed", linked[0]);
    const twin = stored.find((each) => each.hostKey === host.noisePublicKey);
    if (twin !== undefined) return match("paired", twin, twin.account === undefined);
    return match("unpaired");
  });
}

/** A pairing socket closed; the code distinguishes a refusal from a broken path. */
export class PairingHandshakeError extends Error {
  readonly code?: number;

  constructor(code?: number) {
    super(code === undefined ? "pairing connection closed" : `pairing connection closed (${code})`);
    this.name = "PairingHandshakeError";
    if (code !== undefined) this.code = code;
  }
}

/** A host refusal (4401) is the only close code that means "this device is not allowed". */
const rejectedPairing = (error: unknown): { code?: number } | undefined => {
  if (error instanceof PairingHandshakeError) {
    return error.code === UNAUTHORIZED_CLOSE_CODE ? { code: error.code } : undefined;
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === UNAUTHORIZED_CLOSE_CODE) return { code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b4401\b/.test(message) ? { code: UNAUTHORIZED_CLOSE_CODE } : undefined;
};

/** What pairViaAccount's connect seam runs: one secure-channel handshake. */
export interface PairConnectArgs {
  readonly url: string;
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  readonly secret: string;
  readonly name: string;
  /** Aborted when this candidate's pairing deadline expires. */
  readonly signal?: AbortSignal;
}

/**
 * The real pairing path: the same IK handshake a QR link drives, minus the
 * durable session — the offer is spent and the device registered by the time
 * the handshake completes, so the socket closes right after `onPaired`.
 */
function pairHandshake(args: PairConnectArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    let connection: FrameConnection | undefined;
    let settled = false;
    const signal = args.signal;
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      connection?.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void => finish(new Error("pairing attempt aborted"));
    if (signal?.aborted) {
      finish(new Error("pairing attempt aborted"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const transport = secureWebSocketTransport({
      url: args.url,
      hostKey: args.hostKey,
      device: args.device,
      pairing: { secret: args.secret, name: args.name },
      onPaired: () => finish(),
    });
    try {
      connection = transport.open({
        message: () => {},
        // Settled already → no-op; before onPaired it's the refusal signal.
        closed: (code) => finish(new PairingHandshakeError(code)),
      });
      // A carrier that reported a synchronous refusal before returning still
      // needs its socket closed.
      if (settled) connection.close();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface AccountPairSettings {
  /** The page's protocol, so a mixed-content candidate is skipped before dialing. */
  readonly pageProtocol?: string;
  /** Per-candidate deadline; pairing must not hang on one path. Defaults to 10s. */
  readonly attemptTimeoutMs?: number;
}

/**
 * The whole "pair this account host" action: ask the server for a vouched
 * offer, normalize it through the pairing-link rule, then try the offered
 * candidates in Auto order with one device identity and one secret. The first
 * verified message 2 ends the action — paired, not necessarily business ready.
 */
export async function pairViaAccount(
  client: AccountClient,
  hostId: string,
  name: string,
  connect: (args: PairConnectArgs) => Promise<void> = pairHandshake,
  settings: AccountPairSettings = {},
): Promise<AccountResult<StoredHost>> {
  const offer = await client.requestPairing(hostId);
  if (!offer.ok) return offer;
  const fragment = accountPairingFragment(offer.value);
  if (fragment === undefined) return fail("invalid_offer");
  const params = new URLSearchParams(fragment);
  const pair = parsePairParam(params.get("pair")!);
  const url = params.get("url");
  if (pair === undefined || url === null) return fail("invalid_offer");
  const hostKey = fromBase64Url(pair.hostKey);
  const device = generateKeyPair();
  const planned = candidatePlan(url, offer.value.endpointSet, { pageProtocol: settings.pageProtocol });
  const diagnostics: (PairCandidateDiagnostic | undefined)[] = planned.map((candidate) =>
    candidate.unsupported === undefined
      ? undefined
      : {
          url: candidate.url,
          role: candidate.role,
          outcome: "unsupported",
          reason: candidate.unsupported,
        },
  );
  const candidates = planned.filter((candidate) => candidate.unsupported === undefined);
  const orderedDiagnostics = (): PairCandidateDiagnostic[] =>
    diagnostics.filter((diagnostic): diagnostic is PairCandidateDiagnostic => diagnostic !== undefined);
  if (candidates.length === 0) return pairFailure(orderedDiagnostics());
  const timeoutMs = settings.attemptTimeoutMs ?? 10_000;
  let paired = false;
  for (let index = 0; index < planned.length; index++) {
    const candidate = planned[index]!;
    if (candidate.unsupported !== undefined) continue;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("pairing attempt aborted")), { once: true });
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("pairing attempt timed out"));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        connect({ url: candidate.url, hostKey, device, secret: pair.secret, name, signal: controller.signal }),
        aborted,
        deadline,
      ]);
      paired = true;
      break;
    } catch (error) {
      // This path failed; a later candidate shares the same device and secret
      // until message 2 verifies (ADR-0032 §4). Keep the per-path evidence:
      // only a real 4401 is a refusal, and a timeout is not a host outage.
      if (timedOut) {
        diagnostics[index] = {
          url: candidate.url,
          role: candidate.role,
          outcome: "timeout",
          reason: `no answer within ${timeoutMs}ms`,
        };
      } else {
        const rejected = rejectedPairing(error);
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics[index] =
          rejected === undefined
            ? { url: candidate.url, role: candidate.role, outcome: "unreachable", reason }
            : {
                url: candidate.url,
                role: candidate.role,
                outcome: "rejected",
                reason,
                ...(rejected.code === undefined ? {} : { code: rejected.code }),
              };
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
  if (!paired) return pairFailure(orderedDiagnostics());
  const endpointSet = offer.value.endpointSet;
  return ok({
    url: endpointSet === undefined ? url : preferredLegacyUrl(url, endpointSet),
    hostKey: pair.hostKey,
    privateKey: toBase64Url(device.privateKey),
    account: { serverOrigin: client.origin, hostId },
    ...(endpointSet === undefined ? {} : { endpointSet }),
  });
}
