// Sign-in with Google, GitHub and Apple (ADR-0044 §3–§6, §9) against a fake
// identity provider: account resolution and merging, the web flow's browser
// binding, the native one-time code, ID token checks, linking and unlinking
// from settings, re-auth for accounts without a password, and Apple's token
// revocation.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAccounts, type LoginLimits } from "../src/accounts.ts";
import { createOAuth, loadOAuthConfig } from "../src/oauth.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { startFakeIdp, type FakeIdentity, type FakeIdp, type FakeProvider, type TokenTweaks } from "./oauth-fake.ts";
import { downgradeToSchema9, fakeMailer, removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const PASSWORD = "correct horse battery";
const OWNER = "owner@example.com";
const MINUTE = 60_000;

const dirs: string[] = [];
const relays: Relay[] = [];
const idps: FakeIdp[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const idp of idps.splice(0)) await idp.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

interface Started {
  readonly relay: Relay;
  readonly idp: FakeIdp;
  readonly mail: ReturnType<typeof fakeMailer>;
  readonly dataDir: string;
  /** Moves the shared clock forward. */
  advance(ms: number): void;
}

async function startServer(options?: {
  readonly registration?: "open" | "closed";
  readonly limits?: LoginLimits;
  readonly dataDir?: string;
  readonly idp?: FakeIdp;
}): Promise<Started> {
  let offset = 0;
  const now = (): number => Date.now() + offset;
  const dataDir = options?.dataDir ?? (await tempDir(dirs));
  const mail = fakeMailer();
  const idp = options?.idp ?? (await startFakeIdp({ now }));
  if (options?.idp === undefined) idps.push(idp);
  const accounts = await openAccounts({
    dataDir,
    bootstrapUser: OWNER,
    bootstrapPassword: PASSWORD,
    registration: options?.registration ?? "open",
    mailer: mail,
    now,
    ...(options?.limits === undefined ? {} : { limits: options.limits }),
  });
  const oauth = createOAuth(idp.config, { now });
  const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, accounts, oauth });
  relays.push(relay);
  return { relay, idp, mail, dataDir, advance: (ms) => (offset += ms) };
}

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly json: Record<string, unknown>;
}

function api(
  relay: Relay,
  options: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: string },
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          } catch {
            // Empty bodies and redirects surface as {}.
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, json });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const post = (relay: Relay, path: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse> =>
  api(relay, { method: "POST", path, body: JSON.stringify(body), ...(headers === undefined ? {} : { headers }) });
const bearer = (token: unknown): Record<string, string> => ({ authorization: `Bearer ${token as string}` });

/** The value of the cookie `name` a response set, or undefined. */
function setCookie(response: ApiResponse, name: string): string | undefined {
  const header = response.headers["set-cookie"];
  for (const line of Array.isArray(header) ? header : header === undefined ? [] : [header]) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq) === name && pair!.slice(eq + 1) !== "") return pair!.slice(eq + 1);
  }
  return undefined;
}

const SESSION_COOKIE = "__Host-pinomad-session";
const location = (response: ApiResponse): string => response.headers.location as string;

/** Where the server sent the browser on the web client, as its query. */
function webLanding(response: ApiResponse): URLSearchParams {
  expect(response.status).toBe(302);
  const url = new URL(location(response));
  expect(url.origin + url.pathname).toBe(`${ORIGIN}/`);
  return url.searchParams;
}

/** The provider's answer back to the server: a GET for Google and GitHub, Apple's form_post. */
function callback(started: Started, provider: FakeProvider, query: Record<string, string>, cookie?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie: `pinomad_oauth=${cookie}` };
  if (provider !== "apple") {
    return api(started.relay, { path: `/api/oauth/${provider}/callback?${new URLSearchParams(query)}`, headers });
  }
  return api(started.relay, {
    method: "POST",
    path: "/api/oauth/apple/callback",
    headers: { ...headers, origin: "https://appleid.apple.com", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(query).toString(),
  });
}

/** A web sign-in from the start redirect to the provider's callback; resolves to the callback's answer. */
async function webSignIn(
  started: Started,
  provider: FakeProvider,
  identity: FakeIdentity,
  options?: { readonly tweaks?: TokenTweaks; readonly user?: string },
): Promise<{ readonly response: ApiResponse; readonly binding: string }> {
  const start = await api(started.relay, { path: `/api/oauth/${provider}/start?client=web` });
  expect(start.status).toBe(302);
  const binding = setCookie(start, "pinomad_oauth");
  expect(binding).toBeDefined();
  const { code, state } = started.idp.authorize(provider, location(start), identity, options?.tweaks);
  const response = await callback(started, provider, { code, state, ...(options?.user === undefined ? {} : { user: options.user }) }, binding);
  return { response, binding: binding! };
}

/** The signed-in session cookie a completed web sign-in set, and the account it is. */
async function sessionOf(started: Started, response: ApiResponse): Promise<{ readonly cookie: string; readonly email: unknown }> {
  const cookie = setCookie(response, SESSION_COOKIE);
  expect(cookie).toBeDefined();
  const me = await api(started.relay, { path: "/api/me", headers: { cookie: `${SESSION_COOKIE}=${cookie!}` } });
  expect(me.status).toBe(200);
  return { cookie: cookie!, email: (me.json.user as { email?: string }).email };
}

/** A new account through the "no account yet" page: the pending record, then Create account. */
async function createViaPending(started: Started, provider: FakeProvider, identity: FakeIdentity): Promise<string> {
  const { response, binding } = await webSignIn(started, provider, identity);
  const pending = webLanding(response).get("oauth_pending");
  expect(pending).toBeTruthy();
  const created = await post(started.relay, `/api/oauth/pending/${pending!}/create`, {}, {
    origin: ORIGIN,
    cookie: `pinomad_oauth=${binding}`,
  });
  expect(created.status).toBe(200);
  return setCookie(created, SESSION_COOKIE)!;
}

const passwordToken = async (started: Started): Promise<string> =>
  (await post(started.relay, "/api/login", { username: OWNER, password: PASSWORD })).json.token as string;

const IDENTITY: Record<FakeProvider, FakeIdentity> = {
  google: { sub: "g-1001", email: "ada@example.com", name: "Ada" },
  github: { sub: "583231", email: "ada@example.com", name: "Ada" },
  apple: { sub: "001234.apple", email: "ada@example.com" },
};

describe("provider configuration", () => {
  it("turns a provider on only when all its variables are set", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadOAuthConfig({
      PINOMAD_SERVER_GOOGLE_CLIENT_ID: "id",
      PINOMAD_SERVER_GOOGLE_CLIENT_SECRET: "secret",
      PINOMAD_SERVER_GITHUB_CLIENT_ID: "id",
      PINOMAD_SERVER_APPLE_SERVICES_ID: "si.example",
      PINOMAD_SERVER_APPLE_TEAM_ID: "TEAM",
      PINOMAD_SERVER_APPLE_KEY_ID: "KEY",
      PINOMAD_SERVER_APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });
    expect(Object.keys(config)).toEqual(["google", "apple"]);
    expect(config.apple?.privateKey).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    expect(config.apple?.bundleId).toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});

describe("sign-in methods", () => {
  it("lists the configured providers; registration no longer depends on mail", async () => {
    const started = await startServer();
    const methods = await api(started.relay, { path: "/api/auth/methods" });
    expect(methods.json).toEqual({ registration: true, email: true, providers: ["google", "github", "apple"] });
  });

  it("answers 404 for a provider the server doesn't have", async () => {
    const started = await startServer();
    expect((await api(started.relay, { path: "/api/oauth/facebook/start?client=web" })).status).toBe(404);
  });
});

describe.each(["google", "github", "apple"] as const)("%s sign-in", (provider) => {
  it("creates an account through the pending page, then signs it back in by subject", async () => {
    const started = await startServer();
    const { response, binding } = await webSignIn(started, provider, IDENTITY[provider]);
    const pending = webLanding(response).get("oauth_pending")!;
    expect(setCookie(response, SESSION_COOKIE)).toBeUndefined();

    const shown = await api(started.relay, { path: `/api/oauth/pending/${pending}`, headers: { cookie: `pinomad_oauth=${binding}` } });
    expect(shown.json).toMatchObject({ provider, email: "ada@example.com" });

    const created = await post(started.relay, `/api/oauth/pending/${pending}/create`, {}, { origin: ORIGIN, cookie: `pinomad_oauth=${binding}` });
    expect(created.status).toBe(200);
    expect((await sessionOf(started, created)).email).toBe("ada@example.com");

    // The provider's email changed since: the subject is what names the account.
    const again = await webSignIn(started, provider, { ...IDENTITY[provider], email: "ada.new@example.com" });
    webLanding(again.response);
    expect((await sessionOf(started, again.response)).email).toBe("ada@example.com");
  });

  it("merges into the account with the same verified email and mails it", async () => {
    const started = await startServer({ registration: "closed" });
    const { response } = await webSignIn(started, provider, { ...IDENTITY[provider], email: OWNER });
    expect([...webLanding(response).keys()]).toEqual([]);
    expect((await sessionOf(started, response)).email).toBe(OWNER);
    await vi.waitFor(() => expect(started.mail.sent.some((mail) => mail.to === OWNER && /new sign-in method/i.test(mail.subject))).toBe(true));
  });

  it("does not merge on an unverified provider email", async () => {
    const started = await startServer();
    const { response, binding } = await webSignIn(started, provider, { ...IDENTITY[provider], email: OWNER, emailVerified: provider === "apple" ? "false" : false });
    const pending = webLanding(response).get("oauth_pending");
    expect(pending).toBeTruthy();
    expect(setCookie(response, SESSION_COOKIE)).toBeUndefined();
    // Nor does it make an account of its own under that address.
    const created = await post(started.relay, `/api/oauth/pending/${pending!}/create`, {}, { origin: ORIGIN, cookie: `pinomad_oauth=${binding}` });
    expect([created.status, created.json.error]).toEqual([400, "no_verified_email"]);
  });

  it("refuses a new account while registration is closed", async () => {
    const started = await startServer({ registration: "closed" });
    const { response } = await webSignIn(started, provider, IDENTITY[provider]);
    expect(webLanding(response).get("oauth_error")).toBe("registration_closed");
  });
});

describe("Apple specifics", () => {
  it("keeps the name Apple sends only the first time", async () => {
    const started = await startServer();
    const user = JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "ada@example.com" });
    const { response, binding } = await webSignIn(started, "apple", IDENTITY.apple, { user });
    const pending = webLanding(response).get("oauth_pending")!;
    const shown = await api(started.relay, { path: `/api/oauth/pending/${pending}`, headers: { cookie: `pinomad_oauth=${binding}` } });
    expect(shown.json).toEqual({ provider: "apple", email: "ada@example.com", name: "Ada Lovelace" });
  });

  it("counts a private relay address as verified", async () => {
    const started = await startServer();
    const relayEmail = "x7d2k@privaterelay.appleid.com";
    const cookie = await createViaPending(started, "apple", { sub: "001.relay", email: relayEmail, emailVerified: "true" });
    const me = await api(started.relay, { path: "/api/me", headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect((me.json.user as { email: string }).email).toBe(relayEmail);
  });

  it("signs in natively from iOS: no account yet, create it, then straight in", async () => {
    const started = await startServer();
    const first = started.idp.appleNative(IDENTITY.apple, { nonce: "raw-nonce" });
    const refused = await post(started.relay, "/api/oauth/apple/native", { ...first, nonce: "raw-nonce" });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ reason: "no_account", email: "ada@example.com" });

    const created = await post(started.relay, `/api/oauth/pending/${refused.json.pending as string}/create`, {});
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ user: { email: "ada@example.com" } });
    expect(typeof created.json.token).toBe("string");

    const again = await post(started.relay, "/api/oauth/apple/native", started.idp.appleNative(IDENTITY.apple));
    expect(again.status).toBe(200);
    expect(again.json.user).toEqual({ username: "ada@example.com", email: "ada@example.com" });
  });

  it("refuses a native token issued to another audience or with another nonce", async () => {
    const started = await startServer();
    const wrongAud = started.idp.appleNative(IDENTITY.apple, { aud: "si.pinomad.web" });
    expect((await post(started.relay, "/api/oauth/apple/native", wrongAud)).status).toBe(401);
    const nonce = started.idp.appleNative(IDENTITY.apple, { nonce: "one" });
    expect((await post(started.relay, "/api/oauth/apple/native", { ...nonce, nonce: "two" })).status).toBe(401);
  });
});

describe("the web flow is bound to the browser that started it", () => {
  it("refuses a callback without the binding cookie", async () => {
    const started = await startServer();
    const start = await api(started.relay, { path: "/api/oauth/google/start?client=web" });
    const { code, state } = started.idp.authorize("google", location(start), IDENTITY.google);
    expect(webLanding(await callback(started, "google", { code, state }, randomBytes(32).toString("base64url"))).get("oauth_error")).toBeTruthy();
    expect(webLanding(await callback(started, "google", { code, state })).get("oauth_error")).toBeTruthy();
  });

  it("uses a state once", async () => {
    const started = await startServer({ registration: "closed" });
    const start = await api(started.relay, { path: "/api/oauth/google/start?client=web" });
    const binding = setCookie(start, "pinomad_oauth");
    const { code, state } = started.idp.authorize("google", location(start), { ...IDENTITY.google, email: OWNER });
    const first = await callback(started, "google", { code, state }, binding);
    expect(setCookie(first, SESSION_COOKIE)).toBeDefined();
    const second = await callback(started, "google", { code, state }, binding);
    expect(webLanding(second).get("oauth_error")).toBe("invalid_state");
    expect(setCookie(second, SESSION_COOKIE)).toBeUndefined();
  });

  it("expires a flow after ten minutes", async () => {
    const started = await startServer({ registration: "closed" });
    const start = await api(started.relay, { path: "/api/oauth/google/start?client=web" });
    const binding = setCookie(start, "pinomad_oauth");
    const { code, state } = started.idp.authorize("google", location(start), { ...IDENTITY.google, email: OWNER });
    started.advance(11 * MINUTE);
    expect(webLanding(await callback(started, "google", { code, state }, binding)).get("oauth_error")).toBe("invalid_state");
  });

  it("requires the binding cookie to finish a pending sign-in", async () => {
    const started = await startServer();
    const { response } = await webSignIn(started, "google", IDENTITY.google);
    const pending = webLanding(response).get("oauth_pending")!;
    expect((await api(started.relay, { path: `/api/oauth/pending/${pending}` })).status).toBe(404);
    expect((await post(started.relay, `/api/oauth/pending/${pending}/create`, {}, { origin: ORIGIN })).status).toBe(404);
    expect((await post(started.relay, `/api/oauth/pending/${pending}/create`, {})).status).toBe(404);
  });
});

describe("native clients trade a one-time code with their PKCE verifier", () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  async function nativeSignIn(started: Started, redirectUri: string): Promise<URL> {
    const query = new URLSearchParams({ client: "native", redirect_uri: redirectUri, code_challenge: challenge, state: "client-state" });
    const start = await api(started.relay, { path: `/api/oauth/google/start?${query}` });
    expect(start.status).toBe(302);
    const binding = setCookie(start, "pinomad_oauth");
    expect(binding).toBeDefined();
    const { code, state } = started.idp.authorize("google", location(start), { ...IDENTITY.google, email: OWNER });
    // Another browser can't finish it; the app's own can, once.
    const elsewhere = await callback(started, "google", { code, state });
    expect(new URL(location(elsewhere)).searchParams.get("error")).toBe("invalid_state");
    const restart = await api(started.relay, { path: `/api/oauth/google/start?${query}` });
    const again = started.idp.authorize("google", location(restart), { ...IDENTITY.google, email: OWNER });
    const back = await callback(started, "google", { code: again.code, state: again.state }, setCookie(restart, "pinomad_oauth"));
    expect(back.status).toBe(302);
    return new URL(location(back));
  }

  it("sends the code to pinomad://auth and trades it once for a token session", async () => {
    const started = await startServer();
    const back = await nativeSignIn(started, "pinomad://auth");
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe("pinomad://auth");
    expect(back.searchParams.get("state")).toBe("client-state");
    const code = back.searchParams.get("code")!;
    const session = await post(started.relay, "/api/oauth/token", { code, code_verifier: verifier, device: { id: "Qm3xV8rT2kLp9wYz4nHc1A", name: "iPhone" } });
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({ user: { username: OWNER, email: OWNER } });
    expect(session.json.needsEmail).toBeUndefined();
    expect((await api(started.relay, { path: "/api/me", headers: bearer(session.json.token) })).status).toBe(200);
    expect((await post(started.relay, "/api/oauth/token", { code, code_verifier: verifier })).json.error).toBe("invalid_grant");
  });

  it("accepts a loopback redirect and refuses a wrong verifier or a late trade", async () => {
    const started = await startServer();
    const back = await nativeSignIn(started, "http://127.0.0.1:53682/callback");
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:53682/callback");
    const wrong = await post(started.relay, "/api/oauth/token", { code: back.searchParams.get("code"), code_verifier: "w".repeat(43) });
    expect(wrong.status).toBe(400);

    const late = await nativeSignIn(started, "http://127.0.0.1:53682");
    started.advance(3 * MINUTE);
    expect((await post(started.relay, "/api/oauth/token", { code: late.searchParams.get("code"), code_verifier: verifier })).status).toBe(400);
  });

  it.each([
    "https://evil.example/callback",
    "http://localhost:53682/callback",
    "http://127.0.0.1:53682/other",
    "http://127.0.0.1/callback",
    "pinomad://auth/extra",
    "otherapp://auth",
    "pinomad://auth?x=1",
  ])("refuses redirect_uri %s", async (redirectUri) => {
    const started = await startServer();
    const query = new URLSearchParams({ client: "native", redirect_uri: redirectUri, code_challenge: challenge, state: "s" });
    expect((await api(started.relay, { path: `/api/oauth/google/start?${query}` })).status).toBe(400);
  });
});

describe("a pending sign-in can't be finished by someone it was sent to", () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const STRANGER = { sub: "g-attacker", email: "mallory@example.net" };

  /** A native app's sign-in that found no account, run in the app's browser; the pending id and that browser's binding. */
  async function nativePending(started: Started): Promise<{ readonly id: string; readonly binding: string | undefined }> {
    const query = new URLSearchParams({ client: "native", redirect_uri: "pinomad://auth", code_challenge: challenge, state: "s" });
    const start = await api(started.relay, { path: `/api/oauth/google/start?${query}` });
    const binding = setCookie(start, "pinomad_oauth");
    const { code, state } = started.idp.authorize("google", location(start), STRANGER);
    const back = await callback(started, "google", { code, state }, binding);
    return { id: webLanding(back).get("oauth_pending")!, binding };
  }

  /** The owner, signed in on the web with a cookie. */
  const ownerOnWeb = async (started: Started): Promise<Record<string, string>> => {
    const login = await post(started.relay, "/api/login", { username: OWNER, password: PASSWORD }, { origin: ORIGIN });
    return { cookie: `${SESSION_COOKIE}=${setCookie(login, SESSION_COOKIE)!}`, origin: ORIGIN };
  };

  it("keeps a native app's pending sign-in to the browser it ran in", async () => {
    const started = await startServer();
    const { id } = await nativePending(started);
    const victim = await ownerOnWeb(started);
    expect((await api(started.relay, { path: `/api/oauth/pending/${id}`, headers: victim })).status).toBe(404);
    expect((await post(started.relay, `/api/oauth/pending/${id}/link`, {}, victim)).status).toBe(404);
    expect((await post(started.relay, `/api/oauth/pending/${id}/create`, {}, { origin: ORIGIN })).status).toBe(404);
    expect((await post(started.relay, `/api/oauth/pending/${id}/create`, {})).status).toBe(404);
    // The stranger's identity reached no account.
    const identities = await api(started.relay, { path: "/api/me/identities", headers: victim });
    expect(identities.json.identities).toEqual([]);
  });

  it("finishes a native app's pending sign-in in its own browser, at the app's redirect", async () => {
    const started = await startServer();
    const { id, binding } = await nativePending(started);
    expect(binding).toBeDefined();
    const created = await post(started.relay, `/api/oauth/pending/${id}/create`, {}, { origin: ORIGIN, cookie: `pinomad_oauth=${binding!}` });
    expect(created.status).toBe(200);
    const back = new URL(created.json.redirect as string);
    expect(back.protocol).toBe("pinomad:");
    const session = await post(started.relay, "/api/oauth/token", { code: back.searchParams.get("code"), code_verifier: verifier });
    expect(session.json.user).toEqual({ username: STRANGER.email, email: STRANGER.email });
  });

  it("lets only iOS itself finish a native Apple pending sign-in", async () => {
    const started = await startServer();
    const pendingId = async (): Promise<string> =>
      (await post(started.relay, "/api/oauth/apple/native", started.idp.appleNative({ sub: "001.mallory", email: "mallory@example.net" }))).json
        .pending as string;
    const victim = await ownerOnWeb(started);
    const id = await pendingId();
    expect((await post(started.relay, `/api/oauth/pending/${id}/link`, {}, victim)).status).toBe(404);
    expect((await post(started.relay, `/api/oauth/pending/${id}/create`, {}, { origin: ORIGIN })).status).toBe(404);
    expect((await api(started.relay, { path: "/api/me/identities", headers: victim })).json.identities).toEqual([]);

    // The app's own calls: linking with its bearer session, or creating in token mode.
    const linked = await post(started.relay, `/api/oauth/pending/${id}/link`, {}, bearer(await passwordToken(started)));
    expect(linked.status).toBe(204);
    const fresh = await post(started.relay, "/api/oauth/apple/native", started.idp.appleNative({ sub: "001.new", email: "new@example.net" }));
    expect((await post(started.relay, `/api/oauth/pending/${fresh.json.pending as string}/create`, {})).status).toBe(200);
  });
});

describe("ID token checks", () => {
  it.each<[string, TokenTweaks]>([
    ["another audience", { aud: "someone-else" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["an expired token", { expiresIn: -60 }],
    ["a nonce from another flow", { nonce: "replayed" }],
    ["a key the JWKS doesn't publish", { unknownKey: true }],
  ])("refuses %s", async (_, tweaks) => {
    const started = await startServer({ registration: "closed" });
    const { response } = await webSignIn(started, "google", { ...IDENTITY.google, email: OWNER }, { tweaks });
    expect(webLanding(response).get("oauth_error")).toBe("invalid_token");
    expect(setCookie(response, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("sign-in methods in settings", () => {
  async function reauthWithPassword(started: Started, token: string): Promise<string> {
    const grant = await post(started.relay, "/api/reauth", { password: PASSWORD }, bearer(token));
    expect(grant.status).toBe(200);
    return grant.json.reauth as string;
  }

  /** Links `identity` to the account behind `token`; resolves to the callback's answer. */
  async function link(started: Started, token: string, provider: FakeProvider, identity: FakeIdentity): Promise<ApiResponse> {
    const reauth = await reauthWithPassword(started, token);
    const started_ = await post(started.relay, `/api/oauth/${provider}/link`, { reauth }, bearer(token));
    expect(started_.status).toBe(200);
    const binding = setCookie(started_, "pinomad_oauth");
    const { code, state } = started.idp.authorize(provider, started_.json.url as string, identity);
    return callback(started, provider, { code, state }, binding);
  }

  it("links a provider to the signed-in account, which then signs in with it", async () => {
    const started = await startServer();
    const token = await passwordToken(started);
    const linked = await link(started, token, "github", { sub: "77", email: "elsewhere@example.net" });
    expect(webLanding(linked).get("oauth_linked")).toBe("github");

    const identities = await api(started.relay, { path: "/api/me/identities", headers: bearer(token) });
    expect(identities.json).toMatchObject({ hasPassword: true, identities: [{ provider: "github", email: "elsewhere@example.net" }] });
    const { response } = await webSignIn(started, "github", { sub: "77", email: "elsewhere@example.net" });
    expect((await sessionOf(started, response)).email).toBe(OWNER);
  });

  it("refuses to link an identity another account has", async () => {
    const started = await startServer();
    await createViaPending(started, "google", IDENTITY.google);
    const linked = await link(started, await passwordToken(started), "google", IDENTITY.google);
    expect(webLanding(linked).get("oauth_error")).toBe("identity_taken");
  });

  it("needs a re-auth grant to start linking", async () => {
    const started = await startServer();
    const token = await passwordToken(started);
    expect((await post(started.relay, "/api/oauth/google/link", {}, bearer(token))).status).toBe(400);
    expect((await post(started.relay, "/api/oauth/google/link", { reauth: "made-up" }, bearer(token))).json.error).toBe("invalid_reauth");
  });

  it("won't unlink the only way into an account, and revokes Apple's token on unlink", async () => {
    const started = await startServer();
    const cookie = await createViaPending(started, "apple", IDENTITY.apple);
    const headers = { cookie: `${SESSION_COOKIE}=${cookie}`, origin: ORIGIN };
    const reauthCode = async (): Promise<string> => {
      expect((await post(started.relay, "/api/reauth/code", {}, headers)).status).toBe(202);
      const grant = await post(started.relay, "/api/reauth", { code: started.mail.codeFor("ada@example.com") }, headers);
      return grant.json.reauth as string;
    };
    let reauth = await reauthCode();
    const refused = await post(started.relay, "/api/me/identities/apple/remove", { reauth }, headers);
    expect([refused.status, refused.json.error]).toEqual([409, "last_method"]);

    // With GitHub linked too, Apple can go, and Apple is told to forget the grant.
    const github = await post(started.relay, "/api/oauth/github/link", { reauth }, headers);
    const binding = setCookie(github, "pinomad_oauth");
    const { code, state } = started.idp.authorize("github", github.json.url as string, { sub: "99", email: "ada@example.com" });
    expect(webLanding(await callback(started, "github", { code, state }, binding)).get("oauth_linked")).toBe("github");
    reauth = await reauthCode();
    expect((await post(started.relay, "/api/me/identities/apple/remove", { reauth }, headers)).status).toBe(204);
    await vi.waitFor(() => expect(started.idp.revokes).toEqual([expect.objectContaining({ token: "apple-refresh-001234.apple-si.pinomad.web", client_id: "si.pinomad.web" })]));
  });
});

describe("re-auth without a password", () => {
  /** A passwordless account from Google, signed in on two devices. */
  async function twoDevices(started: Started): Promise<{ readonly a: Record<string, string>; readonly b: Record<string, string> }> {
    const a = await createViaPending(started, "google", IDENTITY.google);
    const { response } = await webSignIn(started, "google", IDENTITY.google);
    const b = setCookie(response, SESSION_COOKIE)!;
    return { a: { cookie: `${SESSION_COOKIE}=${a}`, origin: ORIGIN }, b: { cookie: `${SESSION_COOKIE}=${b}`, origin: ORIGIN } };
  }

  const grantByCode = async (started: Started, headers: Record<string, string>): Promise<ApiResponse> => {
    expect((await post(started.relay, "/api/reauth/code", {}, headers)).status).toBe(202);
    return post(started.relay, "/api/reauth", { code: started.mail.codeFor("ada@example.com") }, headers);
  };

  it("kicks another device and deletes the account with a mailed code", async () => {
    const started = await startServer();
    const { a, b } = await twoDevices(started);
    const grant = await grantByCode(started, a);
    expect(grant.status).toBe(200);
    const reauth = grant.json.reauth as string;

    const devices = (await api(started.relay, { path: "/api/devices", headers: a })).json as unknown as { id: number; current: boolean }[];
    const other = devices.find((device) => !device.current)!;
    expect((await post(started.relay, `/api/devices/${other.id}/kick`, { reauth }, a)).status).toBe(204);
    expect((await api(started.relay, { path: "/api/me", headers: b })).status).toBe(401);

    // The grant holds for its five minutes.
    expect((await post(started.relay, "/api/me/delete", { reauth }, a)).status).toBe(204);
    expect((await api(started.relay, { path: "/api/me", headers: a })).status).toBe(401);
  });

  it("sets a first password with a grant", async () => {
    const started = await startServer();
    const { a } = await twoDevices(started);
    const reauth = (await grantByCode(started, a)).json.reauth as string;
    expect((await post(started.relay, "/api/password", { reauth, newPassword: "a fresh long password" }, a)).status).toBe(204);
    expect((await post(started.relay, "/api/login", { username: "ada@example.com", password: "a fresh long password" })).status).toBe(200);
  });

  it("changes the email of an account without a password with a grant", async () => {
    const started = await startServer();
    const { a, b } = await twoDevices(started);
    const reauth = (await grantByCode(started, a)).json.reauth as string;
    const next = "ada.next@example.net";

    // A grant from another session buys neither the code nor the change.
    for (const path of ["/api/me/email/code", "/api/me/email"]) {
      const refused = await post(started.relay, path, { email: next, code: "000000", reauth }, b);
      expect([refused.status, refused.json.error]).toEqual([403, "invalid_reauth"]);
    }
    expect(started.mail.sent.some((mail) => mail.to === next)).toBe(false);

    expect((await post(started.relay, "/api/me/email/code", { email: next, reauth }, a)).status).toBe(202);
    const changed = await post(started.relay, "/api/me/email", { email: next, code: started.mail.codeFor(next), reauth }, a);
    expect(changed.status).toBe(200);
    expect((await api(started.relay, { path: "/api/me", headers: a })).json.user).toEqual({ username: next, email: next });
    // Neither works with no confirmation at all.
    expect((await post(started.relay, "/api/me/email/code", { email: "x@example.net" }, a)).status).toBe(400);
  });

  it("ties a grant to the session that got it", async () => {
    const started = await startServer();
    const { a, b } = await twoDevices(started);
    const reauth = (await grantByCode(started, a)).json.reauth as string;
    const refused = await post(started.relay, "/api/me/delete", { reauth }, b);
    expect([refused.status, refused.json.error]).toEqual([403, "invalid_reauth"]);
  });

  it("lets a grant lapse after five minutes", async () => {
    const started = await startServer();
    const { a } = await twoDevices(started);
    const reauth = (await grantByCode(started, a)).json.reauth as string;
    started.advance(6 * MINUTE);
    expect((await post(started.relay, "/api/me/delete", { reauth }, a)).json.error).toBe("invalid_reauth");
  });

  it("counts wrong codes toward the account lockout", async () => {
    const started = await startServer({ limits: { userMaxFailures: 2 } });
    const { a } = await twoDevices(started);
    expect((await post(started.relay, "/api/reauth/code", {}, a)).status).toBe(202);
    const code = started.mail.codeFor("ada@example.com")!;
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    expect((await post(started.relay, "/api/reauth", { code: wrong }, a)).status).toBe(403);
    expect((await post(started.relay, "/api/reauth", { code: wrong }, a)).status).toBe(403);
    expect((await post(started.relay, "/api/reauth", { code }, a)).status).toBe(429);
  });
});

describe("Apple revocation on account delete", () => {
  it("tells Apple without holding up the delete", async () => {
    const started = await startServer();
    const cookie = await createViaPending(started, "apple", IDENTITY.apple);
    const headers = { cookie: `${SESSION_COOKIE}=${cookie}`, origin: ORIGIN };
    expect((await post(started.relay, "/api/reauth/code", {}, headers)).status).toBe(202);
    const reauth = (await post(started.relay, "/api/reauth", { code: started.mail.codeFor("ada@example.com") }, headers)).json.reauth;
    expect((await post(started.relay, "/api/me/delete", { reauth }, headers)).status).toBe(204);
    await vi.waitFor(() => expect(started.idp.revokes.map((form) => form.token)).toEqual(["apple-refresh-001234.apple-si.pinomad.web"]));
  });
});

describe("upgrading from schema 9", () => {
  it("keeps accounts and their sessions", async () => {
    const first = await startServer();
    const token = await passwordToken(first);
    relays.splice(relays.indexOf(first.relay), 1);
    await first.relay.close();
    downgradeToSchema9(first.dataDir);

    const second = await startServer({ dataDir: first.dataDir, idp: first.idp });
    expect((await api(second.relay, { path: "/api/me", headers: bearer(token) })).status).toBe(200);
    expect((await createViaPending(second, "google", IDENTITY.google)).length).toBeGreaterThan(0);
  });
});
