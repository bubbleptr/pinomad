// Server push over the control connection (ADR-0025 §3-4): `registered`
// declares the configured environments, every `push` is re-checked against
// the account binding, per-host and
// global in-flight caps answer `retry`, and a malformed push is a protocol
// violation like any other. Raw /host sockets stand in for hosts.
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
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
  type PushFrame,
  type RegisterFrame,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { openAccounts, type Accounts } from "../src/accounts.ts";
import type { ApnsSender } from "../src/apns.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { removeTempDir, tempDir } from "./support.ts";
import { fakeApns } from "./apns-fake.ts";

const ORIGIN = "https://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const NOISE_KEY = "abcdefghijklmnopqrstuvwx1234567890_-abcdefg";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PEM = privateKey.export({ format: "pem", type: "pkcs8" }) as string;

const dirs: string[] = [];
const relays: Relay[] = [];
const sockets = new Set<WebSocket>();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  for (const relay of relays.splice(0)) await relay.close();
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

/** An ApnsSender double: scripted verdicts, no HTTP/2 anywhere. */
function fakeApnsSender(
  responder?: (request: { token: string; environment: string }) => Promise<import("@pinomad/protocol/relay.ts").PushVerdict>,
): { sender: ApnsSender; calls: { token: string; environment: string }[]; waitForCalls(n: number): Promise<void> } {
  const calls: { token: string; environment: string }[] = [];
  const waiters: { n: number; resolve(): void }[] = [];
  return {
    calls,
    waitForCalls: (n) =>
      new Promise((resolve) => {
        if (calls.length >= n) resolve();
        else waiters.push({ n, resolve });
      }),
    sender: {
      environments: ["production"],
      send: async (request) => {
        calls.push(request);
        for (const waiter of [...waiters]) {
          if (calls.length >= waiter.n) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        return (await responder?.(request)) ?? { result: "accepted", reason: "ok" };
      },
      close: () => Promise.resolve(),
    },
  };
}

async function startServer(options?: {
  readonly push?: ApnsSender;
  readonly pushLimits?: { perHost?: number; total?: number };
}): Promise<{ relay: Relay; accounts: Accounts }> {
  const dataDir = await tempDir(dirs);
  const accounts = await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
  const relay = await startRelay({
    port: 0,
    publicOrigin: ORIGIN,
    registerTimeoutMs: 300,
    accounts,
    ...(options?.push === undefined ? {} : { push: options.push }),
    ...(options?.pushLimits === undefined ? {} : { pushLimits: options.pushLimits }),
  });
  relays.push(relay);
  return { relay, accounts };
}

const asText = (data: unknown): string => (data as Buffer).toString();

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

async function controlFor(relay: Relay, keys: KeyPair, overrides?: Partial<RegisterFrame>): Promise<WebSocket> {
  const { socket, nonce } = await dialHost(relay);
  socket.send(encodeRelayFrame(registerFrame(keys, nonce, overrides)));
  return socket;
}

/** Writes a hosts row bound to the account; returns the Ed25519 keypair owning it. */
function bindHost(accounts: Accounts): KeyPair {
  const keys = ed25519.keygen();
  const db = new DatabaseSync(accounts.dbPath);
  db.prepare(
    "INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, ?, 'test-host', 1, 1)",
  ).run(relayHostId(keys.publicKey), NOISE_KEY);
  db.close();
  return keys;
}

const closeEvent = (socket: WebSocket): Promise<[number, string]> =>
  once(socket, "close").then(([code, reason]) => [code as number, (reason as Buffer).toString()]);

const NOTIFICATION = { title: "T", body: "Finished", collapseId: "ab".repeat(16), hostKey: "k", conversationId: 1 };
const pushFrame = (overrides?: Partial<PushFrame>): PushFrame => ({
  t: "push",
  requestId: "req-1",
  token: "aa".repeat(32),
  environment: "production",
  notification: NOTIFICATION,
  ...overrides,
});

describe("push declaration and authorization", () => {
  it("declares the environments on registered — bound hosts always see the field", async () => {
    const { relay, accounts } = await startServer({ push: fakeApnsSender().sender });
    const bound = await controlFor(relay, bindHost(accounts), { noisePublicKey: NOISE_KEY });
    expect(await nextFrame(bound)).toEqual({ t: "registered", push: ["production"], features: ["name"] });
    // A socket that ignores the new field — the old-host behavior — stays up.
    bound.send(encodeRelayFrame({ t: "pairing-refused", requestId: "x", reason: "no" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bound.readyState).toBe(WebSocket.OPEN);
    bound.close();

    // Bound host, no APNs configured: `push: []` — "push-aware, no keys",
    // distinguishable from a pre-push server's missing field.
    const plain = await startServer();
    const control = await controlFor(plain.relay, bindHost(plain.accounts), { noisePublicKey: NOISE_KEY });
    expect(await nextFrame(control)).toEqual({ t: "registered", push: [], features: ["name"] });
  });

  it("forwards a bound host's push and returns the classified verdict", async () => {
    const apns = fakeApnsSender(async ({ token }) =>
      token === "gone" ? { result: "unregistered", reason: "Unregistered", unregisteredAt: 4242 } : { result: "accepted", reason: "ok" },
    );
    const { relay, accounts } = await startServer({ push: apns.sender });
    const control = await controlFor(relay, bindHost(accounts), { noisePublicKey: NOISE_KEY });
    await nextFrame(control);

    control.send(encodeRelayFrame(pushFrame()));
    expect(await nextFrame(control)).toEqual({ t: "push-result", requestId: "req-1", result: "accepted", reason: "ok" });

    control.send(encodeRelayFrame(pushFrame({ requestId: "req-2", token: "gone" })));
    expect(await nextFrame(control)).toEqual({
      t: "push-result",
      requestId: "req-2",
      result: "unregistered",
      reason: "Unregistered",
      unregisteredAt: 4242,
    });
    expect(apns.calls.map((call) => call.token)).toEqual(["aa".repeat(32), "gone"]);
  });

  it("rejects a push once the host's binding is gone, even on a live control", async () => {
    const apns = fakeApnsSender();
    const { relay, accounts } = await startServer({ push: apns.sender });
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });
    await nextFrame(control);
    // Registered while bound; the row disappears underneath the live control.
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("DELETE FROM hosts WHERE host_id = ?").run(relayHostId(keys.publicKey));
    db.close();
    control.send(encodeRelayFrame(pushFrame()));
    expect(await nextFrame(control)).toEqual({
      t: "push-result",
      requestId: "req-1",
      result: "rejected",
      reason: "unauthorized",
    });
    expect(apns.calls).toHaveLength(0);
  });

  it("answers unavailable for an environment the server didn't configure", async () => {
    const apns = fakeApnsSender();
    const { relay, accounts } = await startServer({ push: apns.sender });
    const control = await controlFor(relay, bindHost(accounts), { noisePublicKey: NOISE_KEY });
    await nextFrame(control);
    control.send(encodeRelayFrame(pushFrame({ environment: "development" })));
    expect(await nextFrame(control)).toEqual({
      t: "push-result",
      requestId: "req-1",
      result: "unavailable",
      reason: "environment not configured",
    });
    expect(apns.calls).toHaveLength(0);
  });

  it("caps in-flight pushes per host and frees the slot on settle", async () => {
    let release: (verdict: import("@pinomad/protocol/relay.ts").PushVerdict) => void = () => {};
    let first = true;
    const apns = fakeApnsSender(() =>
      // Only the first call holds; later calls answer at once — the test holds
      // the slot, not every request.
      first
        ? new Promise((resolve) => {
            first = false;
            release = resolve;
          })
        : Promise.resolve({ result: "accepted", reason: "ok" }),
    );
    const { relay, accounts } = await startServer({ push: apns.sender, pushLimits: { perHost: 1 } });
    const keys = bindHost(accounts);
    const control = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });
    await nextFrame(control);

    control.send(encodeRelayFrame(pushFrame({ requestId: "r1" })));
    await apns.waitForCalls(1);
    // Slot full: the next push on this control gets `retry`, not a call.
    control.send(encodeRelayFrame(pushFrame({ requestId: "r2" })));
    expect(await nextFrame(control)).toEqual({ t: "push-result", requestId: "r2", result: "retry", reason: "rate_limited" });

    // The cap counts the APNs call, not the socket: killing the control still
    // holds the slot until the request settles.
    control.terminate();
    release({ result: "accepted", reason: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = await controlFor(relay, keys, { noisePublicKey: NOISE_KEY });
    await nextFrame(fresh);
    fresh.send(encodeRelayFrame(pushFrame({ requestId: "r3" })));
    expect(await nextFrame(fresh)).toEqual({ t: "push-result", requestId: "r3", result: "accepted", reason: "ok" });
  });
});

describe("push framing discipline", () => {
  it("closes a control that sends a malformed push", async () => {
    const { relay, accounts } = await startServer({ push: fakeApnsSender().sender });
    const control = await controlFor(relay, bindHost(accounts), { noisePublicKey: NOISE_KEY });
    await nextFrame(control);
    control.send(JSON.stringify({ t: "push", requestId: "x", token: "aa", environment: "sandbox" }));
    const [code] = await closeEvent(control);
    expect(code).toBe(1008);
  });

  it("answers a push after ignoring replies to never-asked requestIds", async () => {
    const { relay, accounts } = await startServer({ push: fakeApnsSender().sender });
    const control = await controlFor(relay, bindHost(accounts), { noisePublicKey: NOISE_KEY });
    await nextFrame(control);
    // A pairing reply for a request the server never sent settles nothing —
    // it must not disturb the push stream on the same control.
    control.send(encodeRelayFrame({ t: "pairing", requestId: "never-asked", secret: "s", expiresAt: 1 }));
    control.send(encodeRelayFrame(pushFrame({ requestId: "req-9" })));
    const frame = await nextFrame(control);
    expect(frame).toMatchObject({ t: "push-result", requestId: "req-9", result: "accepted" });
  });
});
