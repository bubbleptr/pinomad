// Server accounts step 2 (ADR-0022 §3): the join-token API, one-shot join/leave
// op connections, and the old↔new host/server compatibility matrix.
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
  verifyRelayChallenge,
  type RegisterFrame,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { openAccounts, type Accounts } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const MINUTE = 60 * 1000;

const dirs: string[] = [];
const relays: Relay[] = [];
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

interface Started {
  readonly relay: Relay;
  readonly accounts: Accounts;
  readonly dataDir: string;
}

async function startServer(options?: { readonly now?: () => number }): Promise<Started> {
  const dataDir = await tempDir(dirs);
  const accounts = await openAccounts({
    dataDir,
    bootstrapUser: "admin",
    bootstrapPassword: GOOD_PASSWORD,
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  const relay = await startRelay({
    port: 0,
    publicOrigin: ORIGIN,
    registerTimeoutMs: 150,
    accounts,
  });
  relays.push(relay);
  return { relay, accounts, dataDir };
}

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly json: Record<string, unknown>;
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
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Non-JSON bodies surface as {}; tests assert on status then.
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, json });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    request.end();
  });
}

const login = async (relay: Relay, username = "admin"): Promise<string> =>
  (await api(relay, { method: "POST", path: "/api/login", body: { username, password: GOOD_PASSWORD } })).json.token as string;

const mintToken = async (relay: Relay, session: string): Promise<{ token: string; expiresAt: number }> => {
  const response = await api(relay, {
    method: "POST",
    path: "/api/join-tokens",
    headers: { authorization: `Bearer ${session}` },
  });
  if (response.status !== 200) throw new Error(`join-tokens returned ${response.status}`);
  return { token: response.json.token as string, expiresAt: response.json.expiresAt as number };
};

const asText = (data: unknown): string => (data as Buffer).toString();

type KeyPair = ReturnType<typeof ed25519.keygen>;

/** Connects /host and returns the socket plus the challenge nonce. */
async function dialHost(relay: Relay): Promise<{ socket: WebSocket; nonce: string }> {
  const socket = new WebSocket(`${relay.url}/host`);
  sockets.add(socket);
  const challengeP = once(socket, "message");
  await once(socket, "open");
  const frame = decodeRelayToHost(asText((await challengeP)[0]));
  if (frame.t !== "challenge") throw new Error("expected challenge");
  return { socket, nonce: frame.nonce };
}

/** Resolves with the next control frame on the socket, or its close code. */
const answered = (socket: WebSocket): Promise<{ frame: RelayToHost } | { closed: number }> =>
  Promise.race([
    once(socket, "message").then(([data]) => ({ frame: decodeRelayToHost(asText(data)) })),
    once(socket, "close").then(([code]) => ({ closed: code as number })),
  ]);

/** A register frame the way a new host builds it: v1 signature plus optional fields. */
function registerFrame(
  keys: KeyPair,
  nonce: string,
  overrides?: Partial<RegisterFrame> & { readonly noisePublicKey?: string },
): RegisterFrame {
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

/** Sends a register for `keys` on a fresh /host socket; resolves with the answer. */
async function register(relay: Relay, keys: KeyPair, overrides?: Parameters<typeof registerFrame>[2]): Promise<{ frame: RelayToHost } | { closed: number }> {
  const { socket, nonce } = await dialHost(relay);
  const reply = answered(socket);
  socket.send(encodeRelayFrame(registerFrame(keys, nonce, overrides)));
  return reply;
}

/** A bound host holding a live control connection; returns the socket. */
async function controlFor(relay: Relay, keys: KeyPair, overrides?: Parameters<typeof registerFrame>[2]): Promise<WebSocket> {
  const { socket, nonce } = await dialHost(relay);
  socket.send(encodeRelayFrame(registerFrame(keys, nonce, overrides)));
  const reply = await answered(socket);
  // Bound hosts get the push declaration — an empty list when no APNs
  // environment is configured (ADR-0025 §4) — and the server's features.
  expect(reply).toEqual({ frame: { t: "registered", push: [], features: ["name", "device-reports"] } });
  return socket;
}

const closeEvent = (socket: WebSocket): Promise<[number, string]> =>
  once(socket, "close").then(([code, reason]) => [code as number, (reason as Buffer).toString()]);

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

const hostRow = (accounts: Accounts, hostId: string): Record<string, unknown> | undefined =>
  new DatabaseSync(accounts.dbPath)
    .prepare("SELECT user_id AS userId, noise_public_key AS noiseKey, name, joined_at AS joinedAt, last_seen_at AS lastSeenAt FROM hosts WHERE host_id = ?")
    .get(hostId) as Record<string, unknown> | undefined;

describe("join tokens", () => {
  it("requires a session and returns token, expiry, and the join command", async () => {
    const { relay } = await startServer();
    // No credential at all is refused by the Origin gate; a bad Bearer gets 401.
    expect((await api(relay, { method: "POST", path: "/api/join-tokens" })).status).toBe(403);
    expect(
      (await api(relay, { method: "POST", path: "/api/join-tokens", headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect((await api(relay, { method: "GET", path: "/api/join-tokens", headers: { authorization: `Bearer ${await login(relay)}` } })).status).toBe(405);

    const session = await login(relay);
    const response = await api(relay, { method: "POST", path: "/api/join-tokens", headers: { authorization: `Bearer ${session}` } });
    expect(response.status).toBe(200);
    const { token, expiresAt, command } = response.json as { token: string; expiresAt: number; command: string };
    // One line for scripts; the install script brings its own Node (#499).
    expect(command).toBe(`curl -fsSL https://pinomad.si/install.sh | sh && PATH="$HOME/.local/bin:$PATH" pinomad join ${ORIGIN} ${token}`);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * MINUTE + 1000);
  });

  it("stores only the token hash in join_tokens", async () => {
    const { relay, accounts } = await startServer();
    const { token } = await mintToken(relay, await login(relay));
    const db = new DatabaseSync(accounts.dbPath);
    const rows = db.prepare("SELECT token_hash AS hash FROM join_tokens").all() as { hash: string }[];
    db.close();
    expect(rows.map((row) => row.hash)).toEqual([sha256Hex(token)]);
    // The plaintext token is nowhere in the table.
    const raw = new DatabaseSync(accounts.dbPath)
      .prepare("SELECT COUNT(*) AS n FROM join_tokens WHERE token_hash = ?")
      .get(token) as { n: number };
    expect(raw.n).toBe(0);
  });
});

describe("join op connection", () => {
  const NOISE_KEY = "abcdefghijklmnopqrstuvwx1234567890_-abcdefg"; // 43-char base64url stand-in

  it("joins a host: binds it, answers joined, and the op socket closes", async () => {
    const { relay, accounts } = await startServer();
    const session = await login(relay);
    const { token } = await mintToken(relay, session);
    const keys = ed25519.keygen();

    const reply = await register(relay, keys, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY, name: "omarchy" });
    expect(reply).toEqual({ frame: { t: "joined", username: "admin" } });
    const row = hostRow(accounts, relayHostId(keys.publicKey));
    expect(row?.noiseKey).toBe(NOISE_KEY);
    expect(row?.name).toBe("omarchy");

    // The hostId now registers as a normal control connection.
    const { socket, nonce } = await dialHost(relay);
    socket.send(encodeRelayFrame(registerFrame(keys, nonce)));
    expect(await answered(socket)).toEqual({ frame: { t: "registered", push: [], features: ["name", "device-reports"] } });
  });

  it("spends a token once: a second join with it is refused", async () => {
    const { relay } = await startServer();
    const { token } = await mintToken(relay, await login(relay));
    const keys = ed25519.keygen();
    expect(await register(relay, keys, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY })).toEqual({
      frame: { t: "joined", username: "admin" },
    });
    expect(await register(relay, ed25519.keygen(), { op: "join", joinToken: token, noisePublicKey: NOISE_KEY })).toEqual({
      frame: { t: "refused", reason: "invalid_token" },
    });
  });

  it("lets only one of two concurrent joins spend the token", async () => {
    const { relay } = await startServer();
    const { token } = await mintToken(relay, await login(relay));
    const [a, b] = await Promise.all([dialHost(relay), dialHost(relay)]);
    const replyA = answered(a.socket);
    const replyB = answered(b.socket);
    a.socket.send(encodeRelayFrame(registerFrame(ed25519.keygen(), a.nonce, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY })));
    b.socket.send(encodeRelayFrame(registerFrame(ed25519.keygen(), b.nonce, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY })));
    const outcomes = (await Promise.all([replyA, replyB])).map((reply) => ("frame" in reply ? reply.frame.t : "closed"));
    expect(outcomes.sort()).toEqual(["joined", "refused"]);
  });

  it("refuses expired tokens distinctly from invalid ones", async () => {
    let now = 1_800_000_000_000;
    const { relay } = await startServer({ now: () => now });
    const { token } = await mintToken(relay, await login(relay));
    now += 11 * MINUTE;
    expect(await register(relay, ed25519.keygen(), { op: "join", joinToken: token, noisePublicKey: NOISE_KEY })).toEqual({
      frame: { t: "refused", reason: "expired_token" },
    });
    expect(await register(relay, ed25519.keygen(), { op: "join", joinToken: "not-a-token", noisePublicKey: NOISE_KEY })).toEqual({
      frame: { t: "refused", reason: "invalid_token" },
    });
  });

  it("does not consume the token when the signature is bad or v2 is missing", async () => {
    const { relay } = await startServer();
    const { token } = await mintToken(relay, await login(relay));
    const keys = ed25519.keygen();

    // Garbage v2 signature: rejected at 4601 before the op even runs.
    const { socket, nonce } = await dialHost(relay);
    socket.send(
      encodeRelayFrame({ t: "register", hostId: relayHostId(keys.publicKey), signature: "AAAA", signatureV2: "AAAA", noisePublicKey: NOISE_KEY, op: "join", joinToken: token }),
    );
    expect(await answered(socket)).toEqual({ closed: RELAY_CLOSE.badSignature });

    // A join without a v2-bound Noise key is refused but must not spend the token.
    expect(await register(relay, keys, { op: "join", joinToken: token })).toEqual({
      frame: { t: "refused", reason: "bad_request" },
    });

    // The same token still works.
    expect(await register(relay, keys, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY })).toEqual({
      frame: { t: "joined", username: "admin" },
    });
  });

  it("rebinds a joined host to another account, keeping its live control", async () => {
    const { relay, accounts } = await startServer();
    // A second user and a join token it owns, straight into the tables.
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run("second", "x", 1);
    const token2 = "second-user-token";
    db.prepare("INSERT INTO join_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)").run(
      sha256Hex(token2),
      Date.now(),
      Date.now() + MINUTE,
    );
    db.close();

    const keys = ed25519.keygen();
    const hostId = relayHostId(keys.publicKey);
    const { token } = await mintToken(relay, await login(relay));
    await register(relay, keys, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY });
    expect(hostRow(accounts, hostId)?.userId).toBe(1);

    // The host's control connection is up (via its binding) and must survive
    // the rebind — an op connection never enters `controls`.
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });
    expect(await register(relay, keys, { op: "join", joinToken: token2, noisePublicKey: NOISE_KEY })).toEqual({
      frame: { t: "joined", username: "second" },
    });
    expect(hostRow(accounts, hostId)?.userId).toBe(2);

    const incomingP = once(control, "message");
    const device = new WebSocket(`${relay.url}/c/${hostId}`);
    sockets.add(device);
    await once(device, "open");
    expect(decodeRelayToHost(asText((await incomingP)[0])).t).toBe("incoming");
  });

  it("refuses join operations when the server runs without accounts", async () => {
    const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, registerTimeoutMs: 150 });
    relays.push(relay);
    const keys = ed25519.keygen();
    const { socket, nonce } = await dialHost(relay);
    const reply = answered(socket);
    // Even correctly signed, a server without accounts answers refused — the
    // hostId lands nowhere.
    const hostId = relayHostId(keys.publicKey);
    socket.send(
      encodeRelayFrame({
        t: "register",
        hostId,
        signature: signRelayChallenge(keys.secretKey, { relayOrigin: ORIGIN, hostId, nonce }),
        signatureV2: signRelayChallengeV2(keys.secretKey, { relayOrigin: ORIGIN, hostId, nonce, noisePublicKey: NOISE_KEY }),
        noisePublicKey: NOISE_KEY,
        op: "join",
        joinToken: "whatever",
      }),
    );
    expect(await reply).toEqual({ frame: { t: "refused", reason: "accounts_disabled" } });
  });
});

describe("leave op connection", () => {
  const NOISE_KEY = "abcdefghijklmnopqrstuvwx1234567890_-abcdefg";

  it("deletes the binding and closes the live control with 4603", async () => {
    const { relay, accounts } = await startServer();
    const { token } = await mintToken(relay, await login(relay));
    const keys = ed25519.keygen();
    const hostId = relayHostId(keys.publicKey);
    await register(relay, keys, { op: "join", joinToken: token, noisePublicKey: NOISE_KEY });
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });

    expect(await register(relay, keys, { op: "leave", noisePublicKey: NOISE_KEY })).toEqual({ frame: { t: "left" } });
    expect(hostRow(accounts, hostId)).toBeUndefined();
    // Old authorization dies immediately: the bound control gets 4603.
    expect(await closeEvent(control)).toEqual([RELAY_CLOSE.hostNotAllowed, ""]);
  });

  it("refuses leave for a hostId that was never bound", async () => {
    const { relay } = await startServer();
    const keys = ed25519.keygen();
    expect(await register(relay, keys, { op: "leave", noisePublicKey: "x".repeat(43) })).toEqual({
      frame: { t: "refused", reason: "not_joined" },
    });
  });
});

describe("old and new interop", () => {
  const NOISE_KEY = "abcdefghijklmnopqrstuvwx1234567890_-abcdefg";

  it("admits a v1-only register on a bound hostId", async () => {
    const bound = await startServer();
    const db = new DatabaseSync(bound.accounts.dbPath);
    const keys = ed25519.keygen();
    db.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, ?, 'legacy', 1, 1)").run(
      relayHostId(keys.publicKey),
      NOISE_KEY,
    );
    db.close();
    // Old hosts send {t, hostId, signature} and nothing else. A bound one
    // still gets the push declaration ([] = push-aware, nothing configured).
    expect(await register(bound.relay, keys)).toEqual({ frame: { t: "registered", push: [], features: ["name", "device-reports"] } });
  });

  it("a new-style register still verifies under the old server's rules", async () => {
    // The old server (pre-accounts, what's on Zeabur) only read t/hostId/
    // signature and checked `pinomad-relay/1`. Reproduce exactly that here:
    // extra fields must be ignorable and the v1 signature must still verify.
    const keys = ed25519.keygen();
    const hostId = relayHostId(keys.publicKey);
    const nonce = "nonce-123";
    const frame = encodeRelayFrame(
      registerFrame(keys, nonce, { noisePublicKey: NOISE_KEY, features: ["pairing"], name: "omarchy" }),
    );
    const decoded = JSON.parse(frame) as { t: string; hostId: string; signature: string };
    expect(decoded.t).toBe("register");
    expect(
      verifyRelayChallenge(decoded.signature, { relayOrigin: ORIGIN, hostId: decoded.hostId, nonce }),
    ).toBe(true);
    // And the hostId an old server keyed its allowlist on is untouched.
    expect(decoded.hostId).toBe(hostId);
  });

  it("records the v2-bound Noise key and features on the live control", async () => {
    const { relay, accounts } = await startServer();
    const keys = ed25519.keygen();
    const hostId = relayHostId(keys.publicKey);
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, ?, 'h', 1, 1)").run(
      hostId,
      NOISE_KEY,
    );
    db.close();

    await controlFor(relay, keys, { noisePublicKey: "live-key", features: ["pairing"] });
    expect(relay.controlInfo(hostId)).toEqual({ noisePublicKey: "live-key", features: ["pairing"] });

    // A v1-only register can't claim a Noise key: the field is dropped.
    await controlFor(relay, keys);
    expect(relay.controlInfo(hostId)?.noisePublicKey).toBeUndefined();

    // Registering refreshes last_seen_at on the binding.
    const seen = new DatabaseSync(accounts.dbPath)
      .prepare("SELECT last_seen_at AS at FROM hosts WHERE host_id = ?")
      .get(hostId) as { at: number };
    expect(seen.at).toBeGreaterThan(1);
  });
});
