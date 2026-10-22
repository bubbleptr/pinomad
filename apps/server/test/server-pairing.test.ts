// Server accounts step 4 (ADR-0022 §4): /api/hosts and server-vouched pairing —
// the API asks a bound host for a one-time offer over its control connection.
// "Hosts" here are raw /host sockets, so the test chooses exactly when (or
// whether) they reply — no sleeps for coordination.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  decodeRelayToHost,
  encodeRelayFrame,
  RELAY_CLOSE,
  relayHostId,
  signRelayChallenge,
  signRelayChallengeV2,
  type HostToRelay,
  type RegisterFrame,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { openAccounts, type Accounts } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const WS_ORIGIN = "wss://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const NOISE_KEY = "abcdefghijklmnopqrstuvwx1234567890_-abcdefg"; // 43-char base64url stand-in
const OTHER_NOISE_KEY = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

const dirs: string[] = [];
const relays: Relay[] = [];
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function startServer(options?: { readonly pairingTimeoutMs?: number }): Promise<{ relay: Relay; accounts: Accounts }> {
  const dataDir = await tempDir(dirs);
  const accounts = await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
  const relay = await startRelay({
    port: 0,
    publicOrigin: ORIGIN,
    registerTimeoutMs: 150,
    ...(options?.pairingTimeoutMs === undefined ? {} : { pairingTimeoutMs: options.pairingTimeoutMs }),
    accounts,
  });
  relays.push(relay);
  return { relay, accounts };
}

interface ApiResponse {
  readonly status: number;
  readonly json: unknown;
}

function api(
  relay: Relay,
  options: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: unknown },
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

const login = async (relay: Relay): Promise<string> =>
  ((await api(relay, { method: "POST", path: "/api/login", body: { username: "admin", password: GOOD_PASSWORD } })).json as {
    token: string;
  }).token;

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const asText = (data: unknown): string => (data as Buffer).toString();
const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

type KeyPair = ReturnType<typeof ed25519.keygen>;

async function dialHost(relay: Relay): Promise<{ socket: WebSocket; nonce: string }> {
  const socket = new WebSocket(`${relay.url}/host`);
  sockets.add(socket);
  const challengeP = once(socket, "message");
  await once(socket, "open");
  const frame = decodeRelayToHost(asText((await challengeP)[0]));
  if (frame.t !== "challenge") throw new Error("expected challenge");
  return { socket, nonce: frame.nonce };
}

const nextFrame = (socket: WebSocket): Promise<RelayToHost> =>
  once(socket, "message").then(([data]) => decodeRelayToHost(asText(data)));

function registerFrame(keys: KeyPair, nonce: string, overrides?: Partial<RegisterFrame>): HostToRelay {
  const hostId = relayHostId(keys.publicKey);
  const args = { relayOrigin: ORIGIN, hostId, nonce };
  const noise = overrides?.noisePublicKey;
  return {
    t: "register",
    hostId,
    signature: signRelayChallenge(keys.secretKey, args),
    ...(noise === undefined
      ? {}
      : { noisePublicKey: noise, signatureV2: signRelayChallengeV2(keys.secretKey, { ...args, noisePublicKey: noise }) }),
    ...overrides,
  };
}

/** A bound hostId holding a live, pairing-capable control connection. */
async function controlFor(
  relay: Relay,
  keys: KeyPair,
  overrides?: Partial<RegisterFrame>,
): Promise<WebSocket> {
  const { socket, nonce } = await dialHost(relay);
  socket.send(encodeRelayFrame(registerFrame(keys, nonce, overrides)));
  // Bound hosts always get the push declaration — [] here (no APNs configured).
  expect(await nextFrame(socket)).toEqual({ t: "registered", push: [], features: ["name"] });
  return socket;
}

/** Writes a hosts row bound to `userId`; returns the Ed25519 keypair owning it. */
function bindHost(accounts: Accounts, options?: { userId?: number; noiseKey?: string; name?: string }): KeyPair {
  const keys = ed25519.keygen();
  const db = new DatabaseSync(accounts.dbPath);
  db.prepare(
    "INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)",
  ).run(relayHostId(keys.publicKey), options?.userId ?? 1, options?.noiseKey ?? NOISE_KEY, options?.name ?? "test-host");
  db.close();
  return keys;
}

/** A second account with a live session token, inserted straight into the tables. */
function secondUser(accounts: Accounts): string {
  const db = new DatabaseSync(accounts.dbPath);
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('second', 'x', 1)").run();
  const token = "second-user-session";
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 2, 1, ?)").run(
    sha256Hex(token),
    Date.now() + 60_000,
  );
  db.close();
  return token;
}

const closeEvent = (socket: WebSocket): Promise<[number, string]> =>
  once(socket, "close").then(([code, reason]) => [code as number, (reason as Buffer).toString()]);

const pairingPath = (keys: KeyPair): string => `/api/hosts/${relayHostId(keys.publicKey)}/pairing`;

describe("GET /api/hosts", () => {
  it("lists only the caller's hosts with live pairing status", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    expect((await api(relay, { path: "/api/hosts", headers: bearer(session) })).json).toEqual([]);

    const keys = bindHost(accounts);
    const hostId = relayHostId(keys.publicKey);
    const offline = await api(relay, { path: "/api/hosts", headers: bearer(session) });
    expect(offline.json).toEqual([
      { hostId, name: "test-host", noisePublicKey: NOISE_KEY, online: false, lastSeenAt: 1, pairing: "offline" },
    ]);

    await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const online = (await api(relay, { path: "/api/hosts", headers: bearer(session) })).json as { pairing: string; online: boolean }[];
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({ hostId, online: true, pairing: "available" });

    // Another account sees nothing — bindings are per-user.
    expect((await api(relay, { path: "/api/hosts", headers: bearer(secondUser(accounts)) })).json).toEqual([]);
  });

  it("reports host_too_old for controls without the feature or a v2-bound key", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);

    // No features: the server must never send it a pairing-request.
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });
    let hosts = (await api(relay, { path: "/api/hosts", headers: bearer(session) })).json as { pairing: string }[];
    expect(hosts[0]!.pairing).toBe("host_too_old");

    // A v1-only register reports no Noise key: same verdict.
    await controlFor(relay, keys); // replaces the control above
    await closeEvent(control);
    hosts = (await api(relay, { path: "/api/hosts", headers: bearer(session) })).json as { pairing: string }[];
    expect(hosts[0]!.pairing).toBe("host_too_old");
  });

  it("reports key_mismatch when the live key differs from the join-time row", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);
    await controlFor(relay, keys, { noisePublicKey: OTHER_NOISE_KEY, features: ["pairing"] });
    const hosts = (await api(relay, { path: "/api/hosts", headers: bearer(session) })).json as {
      pairing: string;
      online: boolean;
    }[];
    expect(hosts[0]).toMatchObject({ pairing: "key_mismatch", online: true });
  });

  it("requires a session and the right method", async () => {
    const { relay } = await startServer();
    expect((await api(relay, { path: "/api/hosts" })).status).toBe(401);
    const session = await login(relay);
    const post = await api(relay, { method: "POST", path: "/api/hosts", headers: bearer(session) });
    expect(post.status).toBe(405);
  });
});

describe("POST /api/hosts/:hostId/pairing", () => {
  it("asks the host over its control connection and returns url/hostKey/secret", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });

    const requestP = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    const ask = await nextFrame(control);
    expect(ask.t).toBe("pairing-request");
    const requestId = (ask as { requestId: string }).requestId;
    control.send(encodeRelayFrame({ t: "pairing", requestId, secret: "the-secret", expiresAt: 4242 }));

    const response = await requestP;
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      url: `${WS_ORIGIN}/c/${relayHostId(keys.publicKey)}`,
      hostKey: NOISE_KEY,
      secret: "the-secret",
      expiresAt: 4242,
    });
  });

  it("maps the host's refusal reason to a 409 error", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });

    const requestP = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    const ask = (await nextFrame(control)) as { requestId: string };
    control.send(encodeRelayFrame({ t: "pairing-refused", requestId: ask.requestId, reason: "disabled" }));
    const response = await requestP;
    expect(response.status).toBe(409);
    expect(response.json).toEqual({ error: "disabled" });
  });

  it("returns 404 for unknown and foreign hostIds without probing them", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    secondUser(accounts);
    const keys = bindHost(accounts, { userId: 2 }); // belongs to another account
    for (const path of [pairingPath(keys), `/api/hosts/${relayHostId(ed25519.keygen().publicKey)}/pairing`]) {
      const response = await api(relay, { method: "POST", path, headers: bearer(session) });
      expect(response.status).toBe(404);
    }
  });

  it("refuses offline, too-old, and key-mismatched hosts before asking", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);

    expect((await api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) })).json).toEqual({
      error: "host_offline",
    });

    // No features → host_too_old, and nothing may reach the control: the
    // first frame it sees is an `incoming` triggered by a device dial.
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });
    const incomingP = nextFrame(control);
    expect((await api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) })).json).toEqual({
      error: "host_too_old",
    });
    const device = new WebSocket(`${relay.url}/c/${relayHostId(keys.publicKey)}`);
    sockets.add(device);
    expect(await incomingP).toMatchObject({ t: "incoming" });
    control.close();

    const mismatched = await controlFor(relay, keys, { noisePublicKey: OTHER_NOISE_KEY, features: ["pairing"] });
    expect((await api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) })).json).toEqual({
      error: "key_mismatch",
    });
    mismatched.close();
  });

  it("times out a silent host with 504", async () => {
    const { relay, accounts } = await startServer({ pairingTimeoutMs: 80 });
    const session = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const requestP = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    await nextFrame(control); // the ask arrived; the host never answers
    const response = await requestP;
    expect(response.status).toBe(504);
    expect(response.json).toEqual({ error: "host_timeout" });
    // The control survives: a late reply is ignored, not a violation.
    control.send(encodeRelayFrame({ t: "pairing", requestId: "whatever", secret: "s", expiresAt: 1 }));
  });

  it("settles a pending ask when its control is replaced or leaves", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);

    // Replacement: the ask lives on control A; B registers, A gets 4609,
    // and the pending HTTP resolves host_offline.
    const a = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const first = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    const ask = (await nextFrame(a)) as { requestId: string };
    const b = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    expect(await closeEvent(a)).toEqual([RELAY_CLOSE.replaced, ""]);
    expect((await first).json).toEqual({ error: "host_offline" });
    // A stale answer on the dead control — or one forged on the new one —
    // settles nothing; a fresh request on B works normally.
    b.send(encodeRelayFrame({ t: "pairing", requestId: ask.requestId, secret: "stale", expiresAt: 1 }));
    const second = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    const askB = (await nextFrame(b)) as { requestId: string };
    b.send(encodeRelayFrame({ t: "pairing", requestId: askB.requestId, secret: "fresh", expiresAt: 9 }));
    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    expect((secondResponse.json as { secret: string }).secret).toBe("fresh");

    // Leave: the binding's removal kills the control and the pending ask.
    const third = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    await nextFrame(b);
    const { socket: op, nonce } = await dialHost(relay);
    op.send(encodeRelayFrame(registerFrame(keys, nonce, { op: "leave", noisePublicKey: NOISE_KEY })));
    expect(await nextFrame(op)).toEqual({ t: "left" });
    expect((await third).json).toEqual({ error: "host_offline" });
  });

  it("kills a pending ask when the host rebinds to another account", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const pendingP = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    await nextFrame(control);

    // The host rejoins under a second account's join token — the op
    // connection leaves the control alone, so without explicit invalidation
    // the minted invite would go out to the previous owner.
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('second', 'x', 1)").run();
    db.prepare("INSERT INTO join_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)").run(
      sha256Hex("rebind-token"),
      Date.now(),
      Date.now() + 60_000,
    );
    db.close();
    const { socket: op, nonce } = await dialHost(relay);
    op.send(encodeRelayFrame(registerFrame(keys, nonce, { op: "join", joinToken: "rebind-token", noisePublicKey: NOISE_KEY })));
    expect(await nextFrame(op)).toEqual({ t: "joined", username: "second" });

    expect((await pendingP).json).toEqual({ error: "host_offline" });
  });

  it("caps in-flight asks per session and per host", async () => {
    const { relay, accounts } = await startServer();
    // Sessions are minted up front: scrypt logins inside the in-flight window
    // could push early asks past the timeout before the cap even applies.
    const session = await login(relay);
    const session2 = await login(relay);
    const session3 = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const path = pairingPath(keys);

    // Per-session cap is 2: the third ask on the same session is refused.
    const p1 = api(relay, { method: "POST", path, headers: bearer(session) });
    const p2 = api(relay, { method: "POST", path, headers: bearer(session) });
    const ask1 = (await nextFrame(control)) as { requestId: string };
    const ask2 = (await nextFrame(control)) as { requestId: string };
    const denied = await api(relay, { method: "POST", path, headers: bearer(session) });
    expect(denied.status).toBe(429);

    // Per-host cap is 4: a second session fills the host to the ceiling, so a
    // brand-new third session — itself empty — is refused on the host cap.
    const p3 = api(relay, { method: "POST", path, headers: bearer(session2) });
    const p4 = api(relay, { method: "POST", path, headers: bearer(session2) });
    const ask3 = (await nextFrame(control)) as { requestId: string };
    const ask4 = (await nextFrame(control)) as { requestId: string };
    expect((await api(relay, { method: "POST", path, headers: bearer(session3) })).status).toBe(429);

    // Settle everything so cleanup is quiet.
    for (const ask of [ask1, ask2, ask3, ask4]) {
      control.send(encodeRelayFrame({ t: "pairing-refused", requestId: ask.requestId, reason: "busy" }));
    }
    await Promise.all([p1, p2, p3, p4]);
  });

  it("cleans up the pending ask when the HTTP client disconnects", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const path = pairingPath(keys);
    const host = "127.0.0.1";

    // Fire a raw request and kill it mid-ask: its requestId is already out.
    const killed = httpRequest({ host, port: relay.port, path, method: "POST", headers: bearer(session) });
    killed.on("error", () => {}); // destroy() surfaces ECONNRESET — expected
    killed.end();
    await nextFrame(control);
    killed.destroy();

    // With the per-session cap at 2, a leaked pending would trip the cap on
    // the second retry; both must reach the control instead. (Frame reads
    // stay sequential — parallel `once` listeners each catch the same frame.)
    const replies: Promise<ApiResponse>[] = [];
    const asks: { requestId: string }[] = [];
    for (let i = 0; i < 2; i += 1) {
      replies.push(api(relay, { method: "POST", path, headers: bearer(session) }));
      asks.push((await nextFrame(control)) as { requestId: string });
    }
    for (const ask of asks) {
      control.send(encodeRelayFrame({ t: "pairing", requestId: ask.requestId, secret: "s", expiresAt: 1 }));
    }
    for (const response of await Promise.all(replies)) expect(response.status).toBe(200);
  });

  it("keeps ignoring protocol violations: a second register or garbage still closes the control", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY, features: ["pairing"] });
    const requestP = api(relay, { method: "POST", path: pairingPath(keys), headers: bearer(session) });
    await nextFrame(control);
    control.send(encodeRelayFrame(registerFrame(keys, "ignored-nonce")));
    expect((await closeEvent(control))[0]).toBe(1008);
    // The ask dies with its control.
    expect((await requestP).json).toEqual({ error: "host_offline" });
  });
});

