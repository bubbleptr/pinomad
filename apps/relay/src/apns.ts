// The server's APNs sender (ADR-0025 §1-2): an ES256 provider token per
// environment signed from the .p8 key — which lives only here, never on a
// host — and one lazily-built HTTP/2 session per environment to Apple. Hosts
// ask for deliveries over the control connection; this module only knows how
// to carry one notification to APNs and classify the answer.
//
// Runs on Node (node:crypto + node:http2). Keys come from environment
// variables as PEM contents and must never reach logs, errors, or HTTP/2
// debug output.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";
import type { ApnsEnvironment, PushNotification, PushVerdict } from "@pinomad/protocol/relay.ts";

/** Per-environment credentials; `authority` exists only so tests can inject a fake APNs. */
export interface ApnsEnvironmentConfig {
  /** The key's Key ID from the Apple developer account. */
  readonly keyId: string;
  /** The .p8 contents (PKCS8 PEM) — an env-var value, not a file path. */
  readonly keyPem: string;
  readonly authority?: string;
}

export interface ApnsConfig {
  readonly teamId: string;
  /** The app's bundle id — the `apns-topic` on every request. */
  readonly topic: string;
  readonly environments: {
    readonly production?: ApnsEnvironmentConfig;
    readonly development?: ApnsEnvironmentConfig;
  };
}

export interface ApnsSender {
  /** Fully-configured environments — only these are declared to hosts. */
  readonly environments: readonly ApnsEnvironment[];
  send(request: {
    readonly token: string;
    readonly environment: ApnsEnvironment;
    readonly notification: PushNotification;
  }): Promise<PushVerdict>;
  close(): Promise<void>;
}

const AUTHORITIES: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};

const PAYLOAD_MAX_BYTES = 4096;
/** Apple's TTL for the notification itself. */
const EXPIRATION_SECONDS = 3600;
/** Apple's provider-token window is 20–60 min; refresh inside it. */
const TOKEN_REFRESH_MS = 45 * 60 * 1000;
/** A silent APNs must answer well inside the host's 10 s control timeout. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Apple asks for at least 15 minutes after a 5xx before retrying. */
const SERVER_ERROR_RETRY_MS = 15 * 60 * 1000;

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/**
 * Read the PINOMAD_SERVER_APNS_* variables (ADR-0025 §1): a shared Team ID and
 * topic, and per environment a Key ID plus the .p8 PEM. Only fully-configured
 * environments come back — a half-set one is dropped with a warning so a
 * push misconfiguration can't take the server down. PEM values arriving with
 * escaped newlines (env-var UIs mangle real ones) are un-escaped.
 */
export function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | undefined {
  const teamId = env.PINOMAD_SERVER_APNS_TEAM_ID?.trim();
  const topic = env.PINOMAD_SERVER_APNS_TOPIC?.trim();
  if (teamId === undefined || teamId === "" || topic === undefined || topic === "") return undefined;

  const loadEnv = (name: "PRODUCTION" | "DEVELOPMENT"): ApnsEnvironmentConfig | undefined => {
    const keyId = env[`PINOMAD_SERVER_APNS_${name}_KEY_ID`]?.trim();
    const keyPem = env[`PINOMAD_SERVER_APNS_${name}_KEY`]?.replace(/\\n/g, "\n").trim();
    if (keyId === undefined && keyPem === undefined) return undefined;
    if (keyId === undefined || keyId === "" || keyPem === undefined || keyPem === "") {
      console.error(`apns: PINOMAD_SERVER_APNS_${name}_KEY and _KEY_ID must both be set — environment disabled`);
      return undefined;
    }
    return { keyId, keyPem };
  };

  const production = loadEnv("PRODUCTION");
  const development = loadEnv("DEVELOPMENT");
  return {
    teamId,
    topic,
    environments: {
      ...(production === undefined ? {} : { production }),
      ...(development === undefined ? {} : { development }),
    },
  };
}

/** Sign the ES256 provider token for `iat` — deterministic shape, fresh signature each call. */
function providerToken(key: KeyObject, keyId: string, teamId: string, iatSeconds: number): string {
  const signingInput = `${base64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${base64url(
    JSON.stringify({ iss: teamId, iat: iatSeconds }),
  )}`;
  // APNs wants the raw r||s signature, not DER.
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

interface EnvironmentState {
  readonly key: KeyObject;
  readonly keyId: string;
  readonly authority: string;
  session?: ClientHttp2Session;
  token?: { readonly jwt: string; readonly issuedAt: number };
}

/** Build the sender; an environment whose key fails to parse is dropped with a warning. */
export function openApns(config: ApnsConfig): ApnsSender {
  const states = new Map<ApnsEnvironment, EnvironmentState>();
  for (const environment of ["production", "development"] as const) {
    const env = config.environments[environment];
    if (env === undefined) continue;
    try {
      states.set(environment, {
        key: createPrivateKey(env.keyPem),
        keyId: env.keyId,
        authority: env.authority ?? AUTHORITIES[environment],
      });
    } catch {
      // The PEM content is secret: report the failure without echoing it.
      console.error(`apns: the ${environment} key is not a valid EC private key — environment disabled`);
    }
  }

  const environments = [...states.keys()];

  /** Cached JWT per environment; re-signed inside Apple's 20–60 min window. */
  const bearerFor = (state: EnvironmentState): string => {
    const now = Date.now();
    if (state.token !== undefined && now - state.token.issuedAt < TOKEN_REFRESH_MS) return state.token.jwt;
    const jwt = providerToken(state.key, state.keyId, config.teamId, Math.floor(now / 1000));
    state.token = { jwt, issuedAt: now };
    return jwt;
  };

  /** One session per environment, rebuilt after GOAWAY/error/close (ADR-0025 §2). */
  const sessionFor = (environment: ApnsEnvironment, state: EnvironmentState): ClientHttp2Session => {
    const existing = state.session;
    if (existing !== undefined && !existing.destroyed && !existing.closed) return existing;
    const session = connect(state.authority);
    const drop = (): void => {
      if (state.session === session) state.session = undefined;
      if (!session.destroyed) session.destroy();
    };
    session.once("goaway", drop);
    session.once("error", drop);
    session.once("close", () => {
      if (state.session === session) state.session = undefined;
    });
    state.session = session;
    return session;
  };

  const payloadFor = (notification: PushNotification): string =>
    JSON.stringify({
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: "default",
        "thread-id": notification.collapseId,
      },
      hostKey: notification.hostKey,
      conversationId: notification.conversationId,
    });

  const classify = (
    environment: ApnsEnvironment,
    status: number,
    headers: IncomingHttpHeaders,
    body: unknown,
    state: EnvironmentState,
  ): PushVerdict => {
    const reason =
      typeof (body as { reason?: unknown } | null)?.reason === "string"
        ? (body as { reason: string }).reason
        : `HTTP ${status}`;
    const timestamp = (body as { timestamp?: unknown } | null)?.timestamp;
    if (status === 200) return { result: "accepted", reason: "ok" };
    if (status === 410) {
      return {
        result: "unregistered",
        reason,
        unregisteredAt: typeof timestamp === "number" ? timestamp : Date.now(),
      };
    }
    if (status === 403 && reason === "ExpiredProviderToken") {
      // Drop the cached JWT — the next send re-signs (ADR-0025 §5).
      state.token = undefined;
      return { result: "retry", reason };
    }
    if (reason === "InvalidProviderToken" || reason === "TooManyProviderTokenUpdates") {
      // The reason outranks the status: 429 TooManyProviderTokenUpdates is our
      // key churn, not rate pressure — both are our config's fault, so the
      // send is rejected (not retried) and the problem logged (ADR-0025 §5).
      console.error(`apns: provider token problem for ${environment}: ${reason}`);
      return { result: "rejected", reason };
    }
    if (status === 429) {
      const retryAfter = Number(headers["retry-after"]);
      return {
        result: "retry",
        reason,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    }
    if (status >= 500) return { result: "retry", reason, retryAfterMs: SERVER_ERROR_RETRY_MS };
    return { result: "rejected", reason };
  };

  return {
    environments,
    async send(request) {
      const state = states.get(request.environment);
      if (state === undefined) return { result: "unavailable", reason: "environment not configured" };
      const body = payloadFor(request.notification);
      if (Buffer.byteLength(body, "utf8") > PAYLOAD_MAX_BYTES) {
        return { result: "rejected", reason: "PayloadTooLarge" };
      }
      return await new Promise<PushVerdict>((resolve) => {
        let session: ClientHttp2Session;
        try {
          session = sessionFor(request.environment, state);
        } catch {
          resolve({ result: "retry", reason: "session unavailable" });
          return;
        }
        let stream;
        try {
          stream = session.request({
            ":method": "POST",
            ":path": `/3/device/${request.token}`,
            authorization: `bearer ${bearerFor(state)}`,
            "apns-push-type": "alert",
            "apns-topic": config.topic,
            "apns-expiration": String(Math.floor(Date.now() / 1000) + EXPIRATION_SECONDS),
            "apns-collapse-id": request.notification.collapseId,
            "content-type": "application/json",
          });
        } catch {
          resolve({ result: "retry", reason: "session unavailable" });
          return;
        }
        let status = 0;
        let responseHeaders: IncomingHttpHeaders = {};
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (verdict: PushVerdict): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream.destroy();
          resolve(verdict);
        };
        const timer = setTimeout(() => finish({ result: "retry", reason: "apns timeout" }), REQUEST_TIMEOUT_MS);
        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
          responseHeaders = headers;
        });
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = undefined;
          }
          finish(classify(request.environment, status, responseHeaders, body, state));
        });
        stream.on("error", () => finish({ result: "retry", reason: "connection error" }));
        stream.on("aborted", () => finish({ result: "retry", reason: "connection aborted" }));
        stream.end(body);
      });
    },
    close() {
      for (const state of states.values()) state.session?.destroy();
      states.clear();
      return Promise.resolve();
    },
  };
}
