// A fake identity provider for Google, GitHub and Apple over plain HTTP on
// loopback: token endpoints that mint RS256 ID tokens from a test key, the
// JWKS, GitHub's /user and /user/emails, and Apple's revoke endpoint, which
// records what it was asked to revoke. "Authorizing" happens in-process: the
// test hands over the authorize URL the server redirected to, and gets back
// the code and state the provider would have sent the browser back with.
import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthConfig } from "../src/oauth.ts";

export type FakeProvider = "google" | "github" | "apple";

/** Who signs in at the provider. */
export interface FakeIdentity {
  readonly sub: string;
  readonly email?: string;
  /** Apple sends a string; default true. */
  readonly emailVerified?: boolean | "true" | "false";
  readonly name?: string;
}

/** Ways to spoil the ID token the next exchange returns. */
export interface TokenTweaks {
  readonly aud?: string;
  readonly iss?: string;
  /** Seconds from now; default an hour. */
  readonly expiresIn?: number;
  readonly nonce?: string;
  /** Sign with a key the JWKS doesn't publish. */
  readonly unknownKey?: boolean;
}

interface Grant {
  readonly provider: FakeProvider;
  readonly identity: FakeIdentity;
  readonly clientId: string;
  readonly redirectUri?: string;
  readonly nonce?: string;
  readonly codeChallenge?: string;
  readonly tweaks?: TokenTweaks;
}

export interface FakeIdp {
  readonly config: OAuthConfig;
  readonly appleBundleId: string;
  /** Every form Apple's revoke endpoint received. */
  readonly revokes: Record<string, string>[];
  /**
   * Plays the provider's authorize page: checks the URL is this provider's,
   * then answers with the code and state it would send the browser back with.
   */
  authorize(provider: FakeProvider, authorizeUrl: string, identity: FakeIdentity, tweaks?: TokenTweaks): { readonly code: string; readonly state: string; readonly redirectUri: string };
  /** What iOS hands the server after native Sign in with Apple. */
  appleNative(identity: FakeIdentity, options?: { readonly nonce?: string } & TokenTweaks): { readonly identityToken: string; readonly authorizationCode: string };
  close(): Promise<void>;
}

const CLIENT = {
  google: { clientId: "google-client", clientSecret: "google-secret" },
  github: { clientId: "github-client", clientSecret: "github-secret" },
  apple: { servicesId: "si.pinomad.web", teamId: "TEAM123456", keyId: "KEY1234567", bundleId: "build.kieran.pinomad" },
};

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
}

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

export async function startFakeIdp(options: { readonly now?: () => number } = {}): Promise<FakeIdp> {
  const now = options.now ?? Date.now;
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const apple = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwks = { keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };

  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, FakeIdentity>();
  const revokes: Record<string, string>[] = [];

  let base = "";
  const issuer = (provider: FakeProvider): string => `${base}/${provider}`;

  const idToken = (grant: Grant): string => {
    const { identity, tweaks } = grant;
    const at = Math.floor(now() / 1000);
    const payload: Record<string, unknown> = {
      iss: tweaks?.iss ?? issuer(grant.provider),
      aud: tweaks?.aud ?? grant.clientId,
      sub: identity.sub,
      iat: at,
      exp: at + (tweaks?.expiresIn ?? 3600),
      ...(tweaks?.nonce !== undefined ? { nonce: tweaks.nonce } : grant.nonce === undefined ? {} : { nonce: grant.nonce }),
      ...(identity.email === undefined ? {} : { email: identity.email, email_verified: identity.emailVerified ?? true }),
      ...(grant.provider === "google" && identity.name !== undefined ? { name: identity.name } : {}),
    };
    return tweaks?.unknownKey === true
      ? signJwt({ alg: "RS256", kid: "rotated-away" }, payload, stranger.privateKey)
      : signJwt({ alg: "RS256", kid: "k1" }, payload, signing.privateKey);
  };

  /** Apple's client secret is an ES256 JWT from the team's key: check it the way Apple would. */
  const appleSecretValid = (secret: string | undefined, clientId: string): boolean => {
    const [header, payload, signature] = (secret ?? "").split(".");
    if (header === undefined || payload === undefined || signature === undefined) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const head = JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>;
    return (
      head.alg === "ES256" &&
      head.kid === CLIENT.apple.keyId &&
      claims.iss === CLIENT.apple.teamId &&
      claims.sub === clientId &&
      claims.aud === issuer("apple") &&
      typeof claims.exp === "number" &&
      claims.exp > now() / 1000 &&
      verify("sha256", Buffer.from(`${header}.${payload}`), { key: apple.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))
    );
  };

  const server: Server = createServer((request, response) => {
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url ?? "/", "http://idp.invalid").pathname;
    void (async () => {
      if (path === "/google/jwks" || path === "/apple/jwks") return json(200, jwks);
      const tokenFor = /^\/(google|github|apple)\/token$/.exec(path);
      if (tokenFor !== null && request.method === "POST") {
        const provider = tokenFor[1] as FakeProvider;
        const form = await readForm(request);
        const grant = grants.get(form.code ?? "");
        grants.delete(form.code ?? "");
        if (grant === undefined || grant.provider !== provider || form.client_id !== grant.clientId) return json(400, { error: "invalid_grant" });
        if (grant.redirectUri !== undefined && form.redirect_uri !== grant.redirectUri) return json(400, { error: "invalid_grant" });
        if (grant.codeChallenge !== undefined) {
          const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
          if (challenge !== grant.codeChallenge) return json(400, { error: "invalid_grant" });
        }
        const secretOk =
          provider === "apple" ? appleSecretValid(form.client_secret, grant.clientId) : form.client_secret === CLIENT[provider].clientSecret;
        if (!secretOk) return json(401, { error: "invalid_client" });
        const accessToken = randomBytes(16).toString("hex");
        accessTokens.set(accessToken, grant.identity);
        if (provider === "github") return json(200, { access_token: accessToken, token_type: "bearer", scope: "read:user,user:email" });
        return json(200, {
          access_token: accessToken,
          id_token: idToken(grant),
          ...(provider === "apple" ? { refresh_token: `apple-refresh-${grant.identity.sub}-${grant.clientId}` } : {}),
        });
      }
      if (path === "/github/user" || path === "/github/user/emails") {
        const identity = accessTokens.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (identity === undefined) return json(401, { message: "Bad credentials" });
        if (path === "/github/user") return json(200, { id: Number(identity.sub), login: `user${identity.sub}`, name: identity.name ?? null });
        const verified = identity.emailVerified === undefined || identity.emailVerified === true || identity.emailVerified === "true";
        return json(200, [
          { email: `other-${identity.sub}@example.net`, primary: false, verified: true },
          ...(identity.email === undefined ? [] : [{ email: identity.email, primary: true, verified }]),
        ]);
      }
      if (path === "/apple/revoke" && request.method === "POST") {
        revokes.push(await readForm(request));
        response.writeHead(200);
        response.end();
        return;
      }
      json(404, { error: "not_found" });
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const endpoints = (provider: FakeProvider) => ({
    authorize: `${base}/${provider}/authorize`,
    token: `${base}/${provider}/token`,
    ...(provider === "github" ? { user: `${base}/github/user`, emails: `${base}/github/user/emails` } : { jwks: `${base}/${provider}/jwks`, issuer: issuer(provider) }),
    ...(provider === "apple" ? { revoke: `${base}/apple/revoke` } : {}),
  });

  return {
    config: {
      google: { ...CLIENT.google, endpoints: endpoints("google") },
      github: { ...CLIENT.github, endpoints: endpoints("github") },
      apple: {
        ...CLIENT.apple,
        privateKey: apple.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        endpoints: endpoints("apple"),
      },
    },
    appleBundleId: CLIENT.apple.bundleId,
    revokes,
    authorize(provider, authorizeUrl, identity, tweaks) {
      const url = new URL(authorizeUrl);
      if (`${url.origin}${url.pathname}` !== `${base}/${provider}/authorize`) throw new Error(`not ${provider}'s authorize page: ${authorizeUrl}`);
      const params = url.searchParams;
      const clientId = params.get("client_id") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const state = params.get("state") ?? "";
      if (params.get("response_type") !== "code" || state === "") throw new Error("not an authorization code request");
      const code = randomBytes(16).toString("hex");
      grants.set(code, {
        provider,
        identity,
        clientId,
        redirectUri,
        ...(params.get("nonce") === null ? {} : { nonce: params.get("nonce")! }),
        ...(params.get("code_challenge") === null ? {} : { codeChallenge: params.get("code_challenge")! }),
        ...(tweaks === undefined ? {} : { tweaks }),
      });
      return { code, state, redirectUri };
    },
    appleNative(identity, options) {
      const { nonce: rawNonce, ...tweaks } = options ?? {};
      const grant: Grant = {
        provider: "apple",
        identity,
        clientId: CLIENT.apple.bundleId,
        // iOS sends Apple the SHA-256 of its raw nonce.
        ...(rawNonce === undefined ? {} : { nonce: createHash("sha256").update(rawNonce).digest("hex") }),
        tweaks,
      };
      const authorizationCode = randomBytes(16).toString("hex");
      grants.set(authorizationCode, grant);
      return { identityToken: idToken(grant), authorizationCode };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
