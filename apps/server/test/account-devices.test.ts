// Account devices and remote revocation (ADR-0037): the server records each
// install that signs in, learns from hosts which public key an account offer
// admitted, and kicking a device asks every host to revoke it. "Hosts" here
// are raw /host sockets, so the test decides exactly what they declare and
// when they answer.
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  decodeRelayToHost,
  encodeRelayFrame,
  relayHostId,
  signRelayChallenge,
  signRelayChallengeV2,
  type HostToRelay,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { openAccounts, type Accounts, type LoginLimits } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { downgradeToSchema3, removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const WRONG = "wrong password here";
const NOISE_KEY = "abcdefghijklmnopqrstuvwx1234567890_-abcdefg";
const PHONE = "phone-device-id-000001"; // 22-char base64url, like a real client's
const LAPTOP = "laptop-device-id-00002";
const DEVICE_KEY = "K".repeat(43);
const REPORTING = ["pairing", "device-reports"];

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

async function startServer(options?: {
  readonly dataDir?: string;
  readonly limits?: LoginLimits;
  readonly now?: () => number;
}): Promise<Started> {
  const dataDir = options?.dataDir ?? (await tempDir(dirs));
  const accounts = await openAccounts({
    dataDir,
    bootstrapUser: "admin",
    bootstrapPassword: GOOD_PASSWORD,
    ...(options?.limits === undefined ? {} : { limits: options.limits }),
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, registerTimeoutMs: 150, accounts });
  relays.push(relay);
  return { relay, accounts, dataDir };
}

async function stop(started: Started): Promise<void> {
  relays.splice(relays.indexOf(started.relay), 1);
  await started.relay.close();
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
          resolve({ status: response.statusCode ?? 0, json: text === "" ? undefined : JSON.parse(text) });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function login(
  relay: Relay,
  device?: { readonly id: string; readonly name?: string },
  username = "admin",
): Promise<string> {
  const response = await api(relay, {
    method: "POST",
    path: "/api/login",
    body: { username, password: GOOD_PASSWORD, ...(device === undefined ? {} : { device }) },
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  return (response.json as { token: string }).token;
}

/** Signs "bob" up through an admin invite; resolves to bob's bearer token. */
async function signUpBob(relay: Relay, device?: { readonly id: string; readonly name?: string }): Promise<string> {
  const admin = await login(relay);
  const invite = ((await api(relay, { method: "POST", path: "/api/invites", headers: bearer(admin) })).json as { code: string }).code;
  const response = await api(relay, {
    method: "POST",
    path: "/api/register",
    body: { invite, username: "bob", password: GOOD_PASSWORD, ...(device === undefined ? {} : { device }) },
  });
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  return (response.json as { token: string }).token;
}

interface DeviceView {
  readonly id: number;
  readonly name?: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly current: boolean;
  readonly kickedAt?: number;
  readonly hosts: readonly { readonly hostId: string; readonly name: string; readonly state: string }[];
}

const devices = async (relay: Relay, token: string): Promise<DeviceView[]> => {
  const response = await api(relay, { path: "/api/devices", headers: bearer(token) });
  expect(response.status).toBe(200);
  return response.json as DeviceView[];
};

const kick = (relay: Relay, token: string, id: number, body: unknown = { password: GOOD_PASSWORD }) =>
  api(relay, { method: "POST", path: `/api/devices/${id}/kick`, headers: bearer(token), body });

const asText = (data: unknown): string => (data as Buffer).toString();
type KeyPair = ReturnType<typeof ed25519.keygen>;

/** Writes a hosts row bound to `userId`; returns the Ed25519 keypair owning it. */
function bindHost(accounts: Accounts, userId = 1): KeyPair {
  const keys = ed25519.keygen();
  const db = new DatabaseSync(accounts.dbPath);
  db.prepare(
    "INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, ?, ?, 'test-host', 1, 1)",
  ).run(relayHostId(keys.publicKey), userId, NOISE_KEY);
  db.close();
  return keys;
}

/**
 * Every frame a control socket receives, buffered from its first byte: the
 * server sends pending revocations right behind `registered`, before a test
 * could attach a listener for them.
 */
const inboxes = new WeakMap<WebSocket, { frames: RelayToHost[]; waiters: ((frame: RelayToHost) => void)[] }>();

function listen(socket: WebSocket): void {
  const inbox = { frames: [] as RelayToHost[], waiters: [] as ((frame: RelayToHost) => void)[] };
  inboxes.set(socket, inbox);
  socket.on("message", (data) => {
    const frame = decodeRelayToHost(asText(data));
    const waiter = inbox.waiters.shift();
    if (waiter === undefined) inbox.frames.push(frame);
    else waiter(frame);
  });
}

function nextFrame(socket: WebSocket): Promise<RelayToHost> {
  const inbox = inboxes.get(socket)!;
  const queued = inbox.frames.shift();
  return queued === undefined ? new Promise((resolve) => inbox.waiters.push(resolve)) : Promise.resolve(queued);
}

/**
 * A live control connection for `keys`, declaring `features`. Resolves after
 * `registered`, with every frame the server sent right behind it (pending
 * revocations) left for `nextFrame`.
 */
async function control(relay: Relay, keys: KeyPair, features: readonly string[] = REPORTING): Promise<WebSocket> {
  const socket = new WebSocket(`${relay.url}/host`);
  sockets.add(socket);
  listen(socket);
  const challengeP = nextFrame(socket);
  await once(socket, "open");
  const challenge = await challengeP;
  if (challenge.t !== "challenge") throw new Error("expected challenge");
  const hostId = relayHostId(keys.publicKey);
  const args = { relayOrigin: ORIGIN, hostId, nonce: challenge.nonce };
  const registeredP = nextFrame(socket);
  socket.send(
    encodeRelayFrame({
      t: "register",
      hostId,
      signature: signRelayChallenge(keys.secretKey, args),
      noisePublicKey: NOISE_KEY,
      signatureV2: signRelayChallengeV2(keys.secretKey, { ...args, noisePublicKey: NOISE_KEY }),
      features,
    }),
  );
  // The server's own declaration doesn't depend on what the host declared.
  expect(await registeredP).toEqual({ t: "registered", push: [], features: ["name", "device-reports"] });
  return socket;
}

const send = (socket: WebSocket, frame: HostToRelay): void => socket.send(encodeRelayFrame(frame));

/**
 * Runs one account pairing ask for `token` on `host`, answering it with an
 * offer that expires at `expiresAt`; resolves to the requestId the server
 * vouched under.
 */
async function vouch(relay: Relay, host: { keys: KeyPair; socket: WebSocket }, token: string, expiresAt = Date.now() + 60_000): Promise<string> {
  const hostId = relayHostId(host.keys.publicKey);
  const responseP = api(relay, { method: "POST", path: `/api/hosts/${hostId}/pairing`, headers: bearer(token) });
  const ask = await nextFrame(host.socket);
  if (ask.t !== "pairing-request") throw new Error(`expected pairing-request, got ${ask.t}`);
  send(host.socket, { t: "pairing", requestId: ask.requestId, secret: "s", expiresAt });
  expect((await responseP).status).toBe(200);
  return ask.requestId;
}

/** Poll until `predicate` holds — the server answers device-admitted with nothing to await. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const hostState = async (relay: Relay, token: string, deviceId: number): Promise<string | undefined> =>
  (await devices(relay, token)).find((device) => device.id === deviceId)?.hosts[0]?.state;

/** Signs in a phone and a laptop as admin, the phone admitted on `host`; resolves to both tokens and the phone's row id. */
async function admittedPhone(started: Started, host: { keys: KeyPair; socket: WebSocket }, publicKey = DEVICE_KEY) {
  const phone = await login(started.relay, { id: PHONE, name: "Phone" });
  const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
  const requestId = await vouch(started.relay, host, phone);
  send(host.socket, { t: "device-admitted", requestId, publicKey });
  const phoneId = (await devices(started.relay, laptop)).find((device) => device.name === "Phone")!.id;
  await until(async () => (await hostState(started.relay, laptop, phoneId)) === "registered");
  return { phone, laptop, phoneId };
}

describe("account devices at sign-in", () => {
  it("keeps one device per client id across logins, and marks the caller's own", async () => {
    const { relay } = await startServer();
    const first = await login(relay, { id: PHONE, name: "Phone" });
    const second = await login(relay, { id: PHONE, name: "  Renamed phone  " });
    await login(relay, { id: LAPTOP, name: "Laptop" });

    const list = await devices(relay, second);
    expect(list).toHaveLength(2);
    const phone = list.find((device) => device.current)!;
    expect(phone.name).toBe("Renamed phone");
    expect(phone.hosts).toEqual([]);
    expect(phone.lastSeenAt).toBeGreaterThanOrEqual(phone.createdAt);
    expect(list.find((device) => !device.current)!.name).toBe("Laptop");
    // Both sessions point at the same device, so either sees it as current.
    expect((await devices(relay, first)).find((device) => device.current)!.id).toBe(phone.id);
  });

  it("gives a login without a device its own unnamed device, keeping only those still in use", async () => {
    const { relay } = await startServer();
    const kept = await login(relay);
    const list = await devices(relay, kept);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBeUndefined();
    expect(list[0]!.current).toBe(true);

    // Each legacy login is a new device; one whose session ended is swept.
    const ended = await login(relay);
    expect(await devices(relay, kept)).toHaveLength(2);
    expect((await api(relay, { method: "POST", path: "/api/logout", headers: bearer(ended) })).status).toBe(204);
    await login(relay);
    expect(await devices(relay, kept)).toHaveLength(2);
  });

  it("records the device a sign-up arrives on", async () => {
    const { relay } = await startServer();
    const bob = await signUpBob(relay, { id: PHONE, name: "Bob's phone" });
    const list = await devices(relay, bob);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Bob's phone", current: true });
  });

  it("refuses a malformed device claim", async () => {
    const { relay } = await startServer();
    for (const device of [
      "phone",
      { name: "no id" },
      { id: "short" },
      { id: "has spaces in it......" },
      { id: "x".repeat(65) },
      { id: PHONE, name: 5 },
    ]) {
      const response = await api(relay, {
        method: "POST",
        path: "/api/login",
        body: { username: "admin", password: GOOD_PASSWORD, device },
      });
      expect(response.status, JSON.stringify(device)).toBe(400);
    }
    // An over-long name is clipped, not refused; a blank one means unknown.
    const clipped = await login(relay, { id: PHONE, name: "n".repeat(200) });
    expect((await devices(relay, clipped))[0]!.name).toBe("n".repeat(64));
    const blank = await login(relay, { id: LAPTOP, name: "   " });
    expect((await devices(relay, blank)).find((device) => device.current)!.name).toBeUndefined();
  });

  it("lists only the caller's account", async () => {
    const { relay } = await startServer();
    await login(relay, { id: PHONE, name: "Admin phone" });
    const bob = await signUpBob(relay, { id: PHONE, name: "Bob's phone" });
    expect((await devices(relay, bob)).map((device) => device.name)).toEqual(["Bob's phone"]);
    expect((await api(relay, { path: "/api/devices" })).status).toBe(401);
    expect((await api(relay, { method: "POST", path: "/api/devices", headers: bearer(bob) })).status).toBe(405);
  });

  it("gives each session of a schema-3 database an unnamed device", async () => {
    const first = await startServer();
    const token = await login(first.relay, { id: PHONE, name: "Phone" });
    await stop(first);
    downgradeToSchema3(first.dataDir);

    const second = await startServer({ dataDir: first.dataDir });
    // The session survived the migration and now has a device of its own.
    const list = await devices(second.relay, token);
    expect(list).toHaveLength(1);
    expect(list[0]!.current).toBe(true);
    expect(list[0]!.name).toBeUndefined();
  });
});

describe("vouching reports (ADR-0037 §2)", () => {
  it("records the key a host admitted under the account's offer", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const { laptop, phoneId } = await admittedPhone(started, { keys, socket });
    const phone = (await devices(started.relay, laptop)).find((device) => device.id === phoneId)!;
    expect(phone.hosts).toEqual([{ hostId: relayHostId(keys.publicKey), name: "test-host", state: "registered" }]);
  });

  it("ignores reports for another host's request, unknown requests, and long-expired offers", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const otherKeys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const other = await control(started.relay, otherKeys);
    const token = await login(started.relay, { id: PHONE, name: "Phone" });

    const requestId = await vouch(started.relay, { keys, socket }, token);
    send(other, { t: "device-admitted", requestId, publicKey: DEVICE_KEY });
    send(socket, { t: "device-admitted", requestId: "unknown-request", publicKey: DEVICE_KEY });
    const expired = await vouch(started.relay, { keys, socket }, token, 1);
    send(socket, { t: "device-admitted", requestId: expired, publicKey: DEVICE_KEY });
    // A report the server accepts lands after the ignored ones on the same
    // sockets, so once it shows, the others have been handled.
    const fresh = await vouch(started.relay, { keys: otherKeys, socket: other }, token);
    send(other, { t: "device-admitted", requestId: fresh, publicKey: DEVICE_KEY });
    send(socket, { t: "name", name: "barrier" });
    await until(async () => (await devices(started.relay, token))[0]!.hosts.length > 0);
    await until(async () => started.accounts.hostFor(1, relayHostId(keys.publicKey))?.name === "barrier");
    expect((await devices(started.relay, token))[0]!.hosts.map((host) => host.hostId)).toEqual([relayHostId(otherKeys.publicKey)]);
  });

  it("caps the offer expiry a host reports, so its grace can't be stretched", async () => {
    let clock = Date.now();
    const started = await startServer({ now: () => clock });
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const token = await login(started.relay, { id: PHONE, name: "Phone" });
    const DAY = 24 * 60 * 60 * 1000;
    // The offer claims to last ten days; the server keeps at most a few minutes.
    const requestId = await vouch(started.relay, { keys, socket }, token, clock + 10 * DAY);
    // Past the capped expiry plus the one-day report grace: ignored.
    clock += DAY + 10 * 60 * 1000;
    expect(started.accounts.recordAdmission(relayHostId(keys.publicKey), requestId, DEVICE_KEY)).toBe("ignored");
  });

  it("still takes a report inside the capped expiry plus grace", async () => {
    let clock = Date.now();
    const started = await startServer({ now: () => clock });
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const token = await login(started.relay, { id: PHONE, name: "Phone" });
    const requestId = await vouch(started.relay, { keys, socket }, token, clock + 10 * 24 * 60 * 60 * 1000);
    clock += 24 * 60 * 60 * 1000;
    expect(started.accounts.recordAdmission(relayHostId(keys.publicKey), requestId, DEVICE_KEY)).toBe("recorded");
  });

  it("reports whether each host sends device reports in /api/hosts", async () => {
    const started = await startServer();
    const reporting = bindHost(started.accounts);
    const old = bindHost(started.accounts);
    const token = await login(started.relay);
    await control(started.relay, reporting);
    await control(started.relay, old, ["pairing"]);
    const hosts = (await api(started.relay, { path: "/api/hosts", headers: bearer(token) })).json as {
      hostId: string;
      deviceReports: boolean;
    }[];
    expect(Object.fromEntries(hosts.map((host) => [host.hostId, host.deviceReports]))).toEqual({
      [relayHostId(reporting.publicKey)]: true,
      [relayHostId(old.publicKey)]: false,
    });
  });
});

describe("kicking a device (ADR-0037 §3)", () => {
  it("signs the device out and has an online host revoke it, cleared only on the host's ack", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const { phone, laptop, phoneId } = await admittedPhone(started, { keys, socket });

    const revokeP = nextFrame(socket);
    expect((await kick(started.relay, laptop, phoneId)).status).toBe(204);
    expect(await revokeP).toEqual({ t: "revoke-device", publicKey: DEVICE_KEY });
    expect((await api(started.relay, { path: "/api/me", headers: bearer(phone) })).status).toBe(401);
    const kicked = (await devices(started.relay, laptop)).find((device) => device.id === phoneId)!;
    expect(kicked.kickedAt).toBeTypeOf("number");
    expect(kicked.hosts[0]!.state).toBe("revoking");

    send(socket, { t: "device-revoked", publicKey: DEVICE_KEY });
    await until(async () => (await hostState(started.relay, laptop, phoneId)) === "revoked");
    // Nothing is left to send on the next register.
    socket.close();
    const again = await control(started.relay, keys);
    const probeP = api(started.relay, { method: "POST", path: `/api/hosts/${relayHostId(keys.publicKey)}/pairing`, headers: bearer(laptop) });
    expect((await nextFrame(again)).t).toBe("pairing-request");
    again.close();
    await probeP;
  });

  it("sends the revocation to an offline host on its next register, until it acks", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const { laptop, phoneId } = await admittedPhone(started, { keys, socket });
    socket.close();
    await once(socket, "close");

    expect((await kick(started.relay, laptop, phoneId)).status).toBe(204);
    expect(await hostState(started.relay, laptop, phoneId)).toBe("revoking");

    // Each register re-sends what is still pending: a host that dropped
    // before acking gets it again.
    const first = await control(started.relay, keys);
    expect(await nextFrame(first)).toEqual({ t: "revoke-device", publicKey: DEVICE_KEY });
    first.close();
    const second = await control(started.relay, keys);
    expect(await nextFrame(second)).toEqual({ t: "revoke-device", publicKey: DEVICE_KEY });
    send(second, { t: "device-revoked", publicKey: DEVICE_KEY });
    await until(async () => (await hostState(started.relay, laptop, phoneId)) === "revoked");
  });

  it("never sends the new frames to a host that didn't declare device-reports", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const reporting = await control(started.relay, keys);
    const { laptop, phoneId } = await admittedPhone(started, { keys, socket: reporting });
    reporting.close();
    await once(reporting, "close");
    expect((await kick(started.relay, laptop, phoneId)).status).toBe(204);

    // The same host comes back as an older build: the pending revocation must
    // wait, and the first frame it sees is the pairing ask that follows.
    const old = await control(started.relay, keys, ["pairing"]);
    const probeP = api(started.relay, { method: "POST", path: `/api/hosts/${relayHostId(keys.publicKey)}/pairing`, headers: bearer(laptop) });
    expect((await nextFrame(old)).t).toBe("pairing-request");
    old.close();
    await probeP;
    expect(await hostState(started.relay, laptop, phoneId)).toBe("revoking");
  });

  it("revokes at once a device a host reports admitted after it was kicked", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const phone = await login(started.relay, { id: PHONE, name: "Phone" });
    const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
    const requestId = await vouch(started.relay, { keys, socket }, phone);
    const phoneId = (await devices(started.relay, laptop)).find((device) => device.name === "Phone")!.id;

    // The phone holds the secret while it is being kicked; its admission
    // reaches the server afterwards.
    expect((await kick(started.relay, laptop, phoneId)).status).toBe(204);
    const revokeP = nextFrame(socket);
    send(socket, { t: "device-admitted", requestId, publicKey: DEVICE_KEY });
    expect(await revokeP).toEqual({ t: "revoke-device", publicKey: DEVICE_KEY });
  });

  it("revokes a report that arrives after the kick even when the device signed in again meanwhile", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const phone = await login(started.relay, { id: PHONE, name: "Phone" });
    const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
    // The host admits the phone but holds the report (its control is down).
    const requestId = await vouch(started.relay, { keys, socket }, phone);
    const phoneId = (await devices(started.relay, laptop)).find((device) => device.name === "Phone")!.id;
    expect((await kick(started.relay, laptop, phoneId)).status).toBe(204);

    // Signing in again un-kicks the device, but the offer it held before the
    // kick stays revoked.
    await login(started.relay, { id: PHONE, name: "Phone" });
    const revokeP = nextFrame(socket);
    send(socket, { t: "device-admitted", requestId, publicKey: DEVICE_KEY });
    expect(await revokeP).toEqual({ t: "revoke-device", publicKey: DEVICE_KEY });
    expect(await hostState(started.relay, laptop, phoneId)).toBe("revoking");
  });

  it("keeps a vouching made after the re-login out of the old kick", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    await login(started.relay, { id: PHONE, name: "Phone" });
    const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
    const phoneId = (await devices(started.relay, laptop)).find((device) => device.name === "Phone")!.id;
    expect((await kick(started.relay, laptop, phoneId)).status).toBe(204);

    const back = await login(started.relay, { id: PHONE, name: "Phone" });
    const requestId = await vouch(started.relay, { keys, socket }, back);
    send(socket, { t: "device-admitted", requestId, publicKey: DEVICE_KEY });
    await until(async () => (await hostState(started.relay, laptop, phoneId)) === "registered");
  });

  it("lets a kicked device sign in again, without undoing the revocations", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const { laptop, phoneId } = await admittedPhone(started, { keys, socket });
    const revokeP = nextFrame(socket);
    await kick(started.relay, laptop, phoneId);
    await revokeP;

    const back = await login(started.relay, { id: PHONE, name: "Phone" });
    const phone = (await devices(started.relay, back)).find((device) => device.current)!;
    expect(phone.id).toBe(phoneId);
    expect(phone.kickedAt).toBeUndefined();
    expect(phone.hosts[0]!.state).toBe("revoking");
  });

  it("refuses the caller's own device, other accounts' devices and unknown ids", async () => {
    const started = await startServer();
    const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
    const own = (await devices(started.relay, laptop))[0]!.id;
    const response = await kick(started.relay, laptop, own);
    expect(response.status).toBe(409);
    expect(response.json).toEqual({ error: "current_device" });

    const bob = await signUpBob(started.relay, { id: PHONE, name: "Bob's phone" });
    const bobsPhone = (await devices(started.relay, bob))[0]!.id;
    expect((await kick(started.relay, laptop, bobsPhone)).status).toBe(404);
    expect((await kick(started.relay, laptop, 99_999)).status).toBe(404);
    expect((await api(started.relay, { path: "/api/me", headers: bearer(bob) })).status).toBe(200);
  });

  it("requires the password, under the login lockout", async () => {
    const started = await startServer({ limits: { userMaxFailures: 2, ipMaxAttempts: 100 } });
    const phone = await login(started.relay, { id: PHONE, name: "Phone" });
    const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
    const phoneId = (await devices(started.relay, laptop)).find((device) => device.name === "Phone")!.id;
    for (let i = 0; i < 2; i += 1) {
      const response = await kick(started.relay, laptop, phoneId, { password: WRONG });
      expect(response.status).toBe(403);
      expect(response.json).toEqual({ error: "wrong_password" });
    }
    expect((await kick(started.relay, laptop, phoneId)).status).toBe(429);
    expect((await api(started.relay, { path: "/api/me", headers: bearer(phone) })).status).toBe(200);
    expect((await devices(started.relay, laptop)).find((device) => device.id === phoneId)!.kickedAt).toBeUndefined();
  });

  it("refuses malformed requests and anonymous callers", async () => {
    const started = await startServer();
    const laptop = await login(started.relay, { id: LAPTOP, name: "Laptop" });
    expect((await kick(started.relay, laptop, 1, {})).status).toBe(400);
    expect((await kick(started.relay, laptop, 1, { password: "x".repeat(2000) })).status).toBe(400);
    expect((await kick(started.relay, "nope", 1)).status).toBe(401);
    expect((await api(started.relay, { path: "/api/devices/1/kick", headers: bearer(laptop) })).status).toBe(405);
  });
});

describe("account device records follow their account and hosts", () => {
  const count = (accounts: Accounts, table: string): number => {
    const db = new DatabaseSync(accounts.dbPath);
    try {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it("deletes devices, vouchings and pending revocations with the account", async () => {
    const started = await startServer();
    const bob = await signUpBob(started.relay, { id: LAPTOP, name: "Laptop" });
    const keys = bindHost(started.accounts, 2);
    const socket = await control(started.relay, keys);
    const phone = await login(started.relay, { id: PHONE }, "bob");
    const requestId = await vouch(started.relay, { keys, socket }, phone);
    send(socket, { t: "device-admitted", requestId, publicKey: DEVICE_KEY });
    const phoneId = (await devices(started.relay, bob)).find((device) => !device.current)!.id;
    await until(async () => (await hostState(started.relay, bob, phoneId)) === "registered");
    socket.close();
    await once(socket, "close");
    expect((await kick(started.relay, bob, phoneId)).status).toBe(204);
    expect(count(started.accounts, "pending_revocations")).toBe(1);

    expect((await api(started.relay, { method: "POST", path: "/api/me/delete", headers: bearer(bob), body: { password: GOOD_PASSWORD } })).status).toBe(204);
    for (const table of ["vouchings", "pending_revocations"]) expect(count(started.accounts, table), table).toBe(0);
    // Only the admin's own device (from minting bob's invite) remains.
    expect(count(started.accounts, "account_devices")).toBe(1);
  });

  it("drops a host's records when it leaves or joins another account", async () => {
    const started = await startServer();
    const keys = bindHost(started.accounts);
    const socket = await control(started.relay, keys);
    const { laptop, phoneId } = await admittedPhone(started, { keys, socket });
    socket.close();
    await once(socket, "close");
    await kick(started.relay, laptop, phoneId);
    expect(count(started.accounts, "pending_revocations")).toBe(1);

    // Re-joining the same account keeps them.
    const hostId = relayHostId(keys.publicKey);
    expect(started.accounts.joinHost({ token: started.accounts.createJoinToken(1).token, hostId, noisePublicKey: NOISE_KEY }).status).toBe("joined");
    expect(await hostState(started.relay, laptop, phoneId)).toBe("revoking");
    // Joining another account drops them.
    await signUpBob(started.relay);
    expect(started.accounts.joinHost({ token: started.accounts.createJoinToken(2).token, hostId, noisePublicKey: NOISE_KEY }).status).toBe("joined");
    expect(count(started.accounts, "vouchings")).toBe(0);
    expect(count(started.accounts, "pending_revocations")).toBe(0);
    expect((await devices(started.relay, laptop)).find((device) => device.id === phoneId)!.hosts).toEqual([]);
  });
});

