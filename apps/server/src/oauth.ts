// Sign-in with Google, GitHub and Apple (ADR-0044 §3): the server is the
// providers' confidential client. This module only speaks to the providers —
// builds authorize URLs, trades codes, checks ID tokens against their JWKS,
// asks GitHub for the verified primary email, signs Apple's client secret and
// revokes Apple's tokens. Accounts, flows and sessions live in accounts.ts.
//
// No OAuth framework: node:crypto verifies RS256 ID tokens and signs Apple's
// ES256 client secret, and the global fetch carries every request with a
// timeout. Each provider is on only when all of its environment variables are
// set; its endpoints sit in a descriptor tests point at a fake provider.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type JsonWebKeyInput, type KeyObject } from "node:crypto";
import { normalizeEmail } from "./accounts.ts";

export type OAuthProvider = "google" | "github" | "apple";

/** In the order /api/auth/methods lists them. */
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["google", "github", "apple"];

/** Where a provider lives; the defaults are the real services. */
export interface ProviderEndpoints {
  readonly authorize: string;
  readonly token: string;
  /** OIDC providers: the signing keys, and the `iss` their ID tokens carry. */
  readonly jwks?: string;
  readonly issuer?: string;
  /** GitHub: the account and its email addresses. */
  readonly user?: string;
  readonly emails?: string;
  /** Apple: where a refresh token is revoked (ADR-0044 §9). */
  readonly revoke?: string;
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly endpoints?: Partial<ProviderEndpoints>;
}

export interface GithubConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly endpoints?: Partial<ProviderEndpoints>;
}

export interface AppleConfig {
  /** The Services ID: the web flow's client_id. */
  readonly servicesId: string;
  readonly teamId: string;
  readonly keyId: string;
  /** The Sign in with Apple key's .p8 contents (PKCS8 PEM). */
  readonly privateKey: string;
  /** The iOS app's bundle id: the audience of native identity tokens and their client_id. */
  readonly bundleId?: string;
  readonly endpoints?: Partial<ProviderEndpoints>;
}

export interface OAuthConfig {
  readonly google?: GoogleConfig;
  readonly github?: GithubConfig;
  readonly apple?: AppleConfig;
}

const DEFAULT_ENDPOINTS: Record<OAuthProvider, ProviderEndpoints> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: "https://accounts.google.com",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
  },
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    jwks: "https://appleid.apple.com/auth/keys",
    issuer: "https://appleid.apple.com",
    revoke: "https://appleid.apple.com/auth/revoke",
  },
};

/** Google's tokens may name their issuer without the scheme. */
const GOOGLE_BARE_ISSUER = "accounts.google.com";

/**
 * Reads PINOMAD_SERVER_GOOGLE_*, _GITHUB_* and _APPLE_*. A provider with
 * none of its variables is off; one with only some is off too, with one line
 * on stderr, so a half-done setup can't take the server down (as APNs).
 */
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const read = (name: string): string | undefined => {
    const value = env[`PINOMAD_SERVER_${name}`]?.replace(/\\n/g, "\n").trim();
    return value === "" ? undefined : value;
  };
  const all = <K extends string>(provider: string, names: Record<K, string>): Record<K, string> | undefined => {
    const values = Object.fromEntries(Object.entries<string>(names).map(([key, name]) => [key, read(name)])) as Record<K, string | undefined>;
    const set = Object.values(values).filter((value) => value !== undefined).length;
    if (set === 0) return undefined;
    if (set < Object.keys(names).length) {
      console.error(`oauth: ${Object.values(names).map((name) => `PINOMAD_SERVER_${name}`).join(", ")} must all be set — ${provider} sign-in disabled`);
      return undefined;
    }
    return values as Record<K, string>;
  };
  const google = all("Google", { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" });
  const github = all("GitHub", { clientId: "GITHUB_CLIENT_ID", clientSecret: "GITHUB_CLIENT_SECRET" });
  const apple = all("Apple", {
    servicesId: "APPLE_SERVICES_ID",
    teamId: "APPLE_TEAM_ID",
    keyId: "APPLE_KEY_ID",
    privateKey: "APPLE_PRIVATE_KEY",
  });
  const bundleId = read("APPLE_BUNDLE_ID");
  return {
    ...(google === undefined ? {} : { google }),
    ...(github === undefined ? {} : { github }),
    ...(apple === undefined ? {} : { apple: { ...apple, ...(bundleId === undefined ? {} : { bundleId }) } }),
  };
}

/** Who the provider says signed in. `subject` is its stable id for the person, never an email. */
export interface ProviderIdentity {
  readonly provider: OAuthProvider;
  readonly subject: string;
  /** Normalized; absent when the provider gave none. */
  readonly email?: string;
  /** Only a verified provider email may merge into or create an account (ADR-0044 §4). */
  readonly emailVerified: boolean;
  readonly name?: string;
  /** Apple: the refresh token to revoke later, and the client_id it was issued to. */
  readonly refreshToken?: string;
  readonly refreshClientId?: string;
}

/** Why a provider's answer was refused: `invalid_token` is an ID token that failed a check, `exchange_failed` everything else. */
export type ProviderFailure = { readonly error: "invalid_token" | "exchange_failed" };

export interface AuthorizeParams {
  readonly state: string;
  readonly nonce: string;
  /** base64url(SHA-256(verifier)); Apple's flow carries none. */
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface OAuthProviders {
  /** The configured providers, in listing order. */
  readonly enabled: readonly OAuthProvider[];
  /** Whether iOS can sign in natively with Apple: a bundle id is configured. */
  readonly appleNative: boolean;
  authorizeUrl(provider: OAuthProvider, params: AuthorizeParams): string;
  /** Trades the callback's code; Apple's first-time `user` JSON carries the name. */
  exchange(
    provider: OAuthProvider,
    args: { readonly code: string; readonly verifier: string; readonly nonce: string; readonly redirectUri: string; readonly user?: string },
  ): Promise<ProviderIdentity | ProviderFailure>;
  /**
   * Native Sign in with Apple: checks the identity token against Apple's
   * keys with the bundle id as audience — and, when `nonce` is given, that
   * the token carries its SHA-256 as iOS sends it — then trades the
   * authorization code for the refresh token.
   */
  verifyAppleNative(args: {
    readonly identityToken: string;
    readonly authorizationCode: string;
    readonly nonce?: string;
    readonly name?: string;
  }): Promise<ProviderIdentity | ProviderFailure>;
  /** Tells Apple to forget a refresh token; never waits, logs a failure (ADR-0044 §9). */
  revokeApple(refreshToken: string, clientId: string): void;
}

const FETCH_TIMEOUT_MS = 10_000;
// A kid the cache doesn't know triggers a refetch, at most this often.
const JWKS_REFETCH_MS = 60_000;
// Apple allows six months; a month is plenty for a cached secret.
const APPLE_SECRET_TTL_S = 30 * 24 * 60 * 60;
const APPLE_SECRET_RENEW_S = 24 * 60 * 60;
const MAX_NAME_CODEPOINTS = 128;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const failure = (error: ProviderFailure["error"]): ProviderFailure => ({ error });

const clipName = (name: string | undefined): string | undefined => {
  const clipped = [...(name ?? "").trim()].slice(0, MAX_NAME_CODEPOINTS).join("").trim();
  return clipped === "" ? undefined : clipped;
};

/** `true` or Apple's `"true"`. */
const truthy = (value: unknown): boolean => value === true || value === "true";

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return (await response.json()) as unknown;
}

const postForm = (url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<unknown> =>
  fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(form).toString(),
  });

/** A JWKS by URL, cached; an unknown kid refetches it, no more than once a minute. */
class JwksCache {
  private readonly sets = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  async key(url: string, kid: string): Promise<KeyObject | undefined> {
    const cached = this.sets.get(url);
    const known = cached?.keys.get(kid);
    if (known !== undefined) return known;
    if (cached !== undefined && this.now() - cached.fetchedAt < JWKS_REFETCH_MS) return undefined;
    const body = await fetchJson(url, { headers: { accept: "application/json" } });
    const keys = new Map<string, KeyObject>();
    for (const jwk of isRecord(body) && Array.isArray(body.keys) ? body.keys : []) {
      if (!isRecord(jwk) || typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKeyInput["key"], format: "jwk" }));
      } catch {
        // A key this runtime can't read is a key nobody can be verified with.
      }
    }
    this.sets.set(url, { keys, fetchedAt: this.now() });
    return keys.get(kid);
  }
}

const decodeSegment = (segment: string): unknown => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

/**
 * The claims of an RS256 ID token whose signature, issuer, audience, expiry
 * and nonce all check out; undefined otherwise.
 */
async function verifyIdToken(
  jwks: JwksCache,
  token: string,
  expect: { readonly jwksUrl: string; readonly issuers: readonly string[]; readonly audience: string; readonly nonce?: string; readonly nowS: number },
): Promise<Record<string, unknown> | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  let header: unknown, claims: unknown;
  try {
    header = decodeSegment(parts[0]!);
    claims = decodeSegment(parts[1]!);
  } catch {
    return undefined;
  }
  if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string" || !isRecord(claims)) return undefined;
  const key = await jwks.key(expect.jwksUrl, header.kid);
  if (key === undefined) return undefined;
  const signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
  if (!signed) return undefined;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.iss !== "string" || !expect.issuers.includes(claims.iss)) return undefined;
  if (!audience.includes(expect.audience)) return undefined;
  if (typeof claims.exp !== "number" || claims.exp <= expect.nowS) return undefined;
  if (expect.nonce !== undefined && claims.nonce !== expect.nonce) return undefined;
  if (typeof claims.sub !== "string" || claims.sub === "") return undefined;
  return claims;
}

/** The email an ID token vouches for, normalized, with whether it is verified. */
function tokenEmail(claims: Record<string, unknown>, relayCountsVerified: boolean): { email?: string; emailVerified: boolean } {
  const email = typeof claims.email === "string" ? normalizeEmail(claims.email) : undefined;
  if (email === undefined) return { emailVerified: false };
  // Apple's private relay addresses always reach the person (ADR-0044 §3).
  const relay = relayCountsVerified && (truthy(claims.is_private_email) || email.endsWith("@privaterelay.appleid.com"));
  return { email, emailVerified: truthy(claims.email_verified) || relay };
}

/** Apple's first-time `user` form field: `{ name: { firstName, lastName } }`. */
function appleName(user: string | undefined): string | undefined {
  if (user === undefined) return undefined;
  try {
    const parsed = JSON.parse(user) as unknown;
    const name = isRecord(parsed) && isRecord(parsed.name) ? parsed.name : undefined;
    const parts = [name?.firstName, name?.lastName].filter((part): part is string => typeof part === "string" && part.trim() !== "");
    return clipName(parts.join(" "));
  } catch {
    return undefined;
  }
}

export function createOAuth(config: OAuthConfig, options: { readonly now?: () => number } = {}): OAuthProviders {
  const now = options.now ?? Date.now;
  const jwks = new JwksCache(now);
  const endpoints = (provider: OAuthProvider): ProviderEndpoints => ({ ...DEFAULT_ENDPOINTS[provider], ...config[provider]?.endpoints });
  const enabled = OAUTH_PROVIDERS.filter((provider) => config[provider] !== undefined);
  const nowS = (): number => Math.floor(now() / 1000);

  const appleKey = config.apple === undefined ? undefined : createPrivateKey(config.apple.privateKey);
  const appleSecrets = new Map<string, { secret: string; expiresAt: number }>();
  /** Apple's client secret for `clientId`: an ES256 JWT from the team's key, reused until near its expiry. */
  const appleSecret = (clientId: string): string => {
    const apple = config.apple!;
    const cached = appleSecrets.get(clientId);
    if (cached !== undefined && cached.expiresAt - nowS() > APPLE_SECRET_RENEW_S) return cached.secret;
    const iat = nowS();
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: apple.keyId })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: apple.teamId, iat, exp: iat + APPLE_SECRET_TTL_S, aud: endpoints("apple").issuer, sub: clientId }),
    ).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: appleKey!, dsaEncoding: "ieee-p1363" });
    const secret = `${header}.${payload}.${signature.toString("base64url")}`;
    appleSecrets.set(clientId, { secret, expiresAt: iat + APPLE_SECRET_TTL_S });
    return secret;
  };

  const oidc = async (
    provider: "google" | "apple",
    idToken: unknown,
    audience: string,
    nonce: string | undefined,
  ): Promise<{ claims: Record<string, unknown> } | ProviderFailure> => {
    const { jwks: jwksUrl, issuer } = endpoints(provider);
    if (typeof idToken !== "string" || jwksUrl === undefined || issuer === undefined) return failure("exchange_failed");
    const issuers = provider === "google" && issuer === DEFAULT_ENDPOINTS.google.issuer ? [issuer, GOOGLE_BARE_ISSUER] : [issuer];
    const claims = await verifyIdToken(jwks, idToken, { jwksUrl, issuers, audience, nowS: nowS(), ...(nonce === undefined ? {} : { nonce }) });
    return claims === undefined ? failure("invalid_token") : { claims };
  };

  const exchangeGoogle = async (args: { code: string; verifier: string; nonce: string; redirectUri: string }): Promise<ProviderIdentity | ProviderFailure> => {
    const google = config.google!;
    const body = await postForm(endpoints("google").token, {
      grant_type: "authorization_code",
      code: args.code,
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    });
    const checked = await oidc("google", isRecord(body) ? body.id_token : undefined, google.clientId, args.nonce);
    if ("error" in checked) return checked;
    const { claims } = checked;
    const name = clipName(typeof claims.name === "string" ? claims.name : undefined);
    return { provider: "google", subject: claims.sub as string, ...tokenEmail(claims, false), ...(name === undefined ? {} : { name }) };
  };

  const exchangeGithub = async (args: { code: string; verifier: string; redirectUri: string }): Promise<ProviderIdentity | ProviderFailure> => {
    const github = config.github!;
    const { token, user: userUrl, emails: emailsUrl } = endpoints("github");
    const body = await postForm(token, {
      code: args.code,
      client_id: github.clientId,
      client_secret: github.clientSecret,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    });
    // GitHub answers a bad code with 200 and an `error` field.
    const accessToken = isRecord(body) && typeof body.access_token === "string" ? body.access_token : undefined;
    if (accessToken === undefined || userUrl === undefined || emailsUrl === undefined) return failure("exchange_failed");
    const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "pinomad-server" };
    const [user, emails] = await Promise.all([fetchJson(userUrl, { headers }), fetchJson(emailsUrl, { headers })]);
    if (!isRecord(user) || typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return failure("exchange_failed");
    // Only the primary address counts, and only once GitHub has verified it.
    const primary = Array.isArray(emails) ? emails.find((entry) => isRecord(entry) && entry.primary === true) : undefined;
    const email = isRecord(primary) && typeof primary.email === "string" ? normalizeEmail(primary.email) : undefined;
    const name = clipName(typeof user.name === "string" ? user.name : undefined);
    return {
      provider: "github",
      subject: String(user.id),
      ...(email === undefined ? {} : { email }),
      emailVerified: email !== undefined && isRecord(primary) && primary.verified === true,
      ...(name === undefined ? {} : { name }),
    };
  };

  /** Apple's token endpoint: the ID token checked for `audience`, plus the refresh token to revoke later. */
  const exchangeApple = async (args: {
    code: string;
    clientId: string;
    redirectUri?: string;
    nonce: string | undefined;
    name: string | undefined;
  }): Promise<ProviderIdentity | ProviderFailure> => {
    const body = await postForm(endpoints("apple").token, {
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      client_secret: appleSecret(args.clientId),
      ...(args.redirectUri === undefined ? {} : { redirect_uri: args.redirectUri }),
    });
    if (!isRecord(body)) return failure("exchange_failed");
    const checked = await oidc("apple", body.id_token, args.clientId, args.nonce);
    if ("error" in checked) return checked;
    const { claims } = checked;
    return {
      provider: "apple",
      subject: claims.sub as string,
      ...tokenEmail(claims, true),
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token, refreshClientId: args.clientId } : {}),
    };
  };

  /** A provider's network or protocol failure is the caller's error page, never a crash. */
  const guarded = async (run: () => Promise<ProviderIdentity | ProviderFailure>, provider: OAuthProvider): Promise<ProviderIdentity | ProviderFailure> => {
    try {
      return await run();
    } catch (error) {
      console.error(JSON.stringify({ event: "oauth_failed", provider, error: error instanceof Error ? error.message : String(error) }));
      return failure("exchange_failed");
    }
  };

  return {
    enabled,
    appleNative: config.apple?.bundleId !== undefined,

    authorizeUrl(provider, { state, nonce, codeChallenge, redirectUri }) {
      const url = new URL(endpoints(provider).authorize);
      const params: Record<string, string> =
        provider === "google"
          ? {
              client_id: config.google!.clientId,
              scope: "openid email profile",
              nonce,
              code_challenge: codeChallenge,
              code_challenge_method: "S256",
            }
          : provider === "github"
            ? { client_id: config.github!.clientId, scope: "read:user user:email", code_challenge: codeChallenge, code_challenge_method: "S256" }
            : // Apple documents no PKCE; state, nonce and the signed client secret carry the flow.
              { client_id: config.apple!.servicesId, scope: "name email", response_mode: "form_post", nonce };
      for (const [key, value] of Object.entries({ response_type: "code", redirect_uri: redirectUri, state, ...params })) {
        url.searchParams.set(key, value);
      }
      return url.toString();
    },

    exchange(provider, args) {
      return guarded(() => {
        if (provider === "google") return exchangeGoogle(args);
        if (provider === "github") return exchangeGithub(args);
        return exchangeApple({ code: args.code, clientId: config.apple!.servicesId, redirectUri: args.redirectUri, nonce: args.nonce, name: appleName(args.user) });
      }, provider);
    },

    verifyAppleNative({ identityToken, authorizationCode, nonce, name }) {
      return guarded(async () => {
        const bundleId = config.apple?.bundleId;
        if (bundleId === undefined) return failure("exchange_failed");
        const hashed = nonce === undefined ? undefined : createHash("sha256").update(nonce).digest("hex");
        // The token iOS holds is checked before anything is traded for it.
        const checked = await oidc("apple", identityToken, bundleId, hashed);
        if ("error" in checked) return checked;
        const traded = await exchangeApple({ code: authorizationCode, clientId: bundleId, nonce: undefined, name: clipName(name) });
        if ("error" in traded) return traded;
        // The code must belong to the same person as the token.
        return traded.subject === checked.claims.sub ? traded : failure("invalid_token");
      }, "apple");
    },

    revokeApple(refreshToken, clientId) {
      const revoke = endpoints("apple").revoke;
      if (config.apple === undefined || revoke === undefined) return;
      void fetch(revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: appleSecret(clientId), token: refreshToken, token_type_hint: "refresh_token" }).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`apple answered ${response.status}`);
        })
        .catch((error: unknown) => {
          console.error(JSON.stringify({ event: "apple_revoke_failed", error: error instanceof Error ? error.message : String(error) }));
        });
    },
  };
}
