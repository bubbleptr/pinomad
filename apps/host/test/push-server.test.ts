// The whole push path end to end (ADR-0025): a real host's sender rides its
// relay control connection to a real relay running the real APNs sender —
// only Apple's endpoint is faked, over cleartext HTTP/2. Covers every APNs
// answer the ADR classifies: 200, 410, 400, 429, 5xx, and
// 403 ExpiredProviderToken with its token refresh.
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAccounts, type Accounts } from "@pinomad/relay/src/accounts.ts";
import { openApns } from "@pinomad/relay/src/apns.ts";
import { startRelay, type Relay } from "@pinomad/relay/src/relay.ts";
import { fakeApns, type FakeApns } from "@pinomad/relay/test/apns-fake.ts";
import { loadHostKey, loadRelayKey } from "../src/devices.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import { PushDoc } from "../src/push.ts";
import { writeServerConfig } from "../src/server-config.ts";
import {
  connectTo,
  freePort,
  ManualTimers,
  pairDevice,
  startChat,
  startFauxHost,
  tempDir,
  useCleanups,
  waitForView,
} from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PEM = privateKey.export({ format: "pem", type: "pkcs8" }) as string;

const GOOD_PASSWORD = "correct horse battery";

/** Hex-shaped APNs tokens — the host refuses anything else. */
const TOKEN_OK = "0a".repeat(32);
const TOKEN_GONE = "0b".repeat(32);
const TOKEN_BAD = "0c".repeat(32);
const TOKEN_BUSY = "0d".repeat(32);
const TOKEN_ERR = "0e".repeat(32);
const TOKEN_JWT = "0f".repeat(32);

const QUESTION_STEP = fauxAssistantMessage(
  fauxToolCall("ask_user_question", {
    questions: [{ header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }],
  }),
  { stopReason: "toolUse" },
);

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const waitForRelayState = (host: OpenedHost, status: string) =>
  waitUntil(() => host.relay?.state().status === status);

const registrations = (host: OpenedHost) =>
  host.harness.snapshot(PushDoc, context).then((doc) => doc?.registrations ?? []);

/**
 * Accounts + relay + the real APNs sender pointed at the fake HTTP/2 service —
 * the `authority` test seam is the only injection (ADR-0025 §6).
 */
async function startServer(
  responder?: Parameters<typeof fakeApns>[0],
  envs: readonly ("production" | "development")[] = ["production"],
): Promise<{ relay: Relay; accounts: Accounts; apns: FakeApns }> {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  const accounts = await openAccounts({ dataDir: dataDir.path, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
  const apns = await fakeApns(responder);
  defer(apns.close);
  const environments: Record<string, { keyId: string; keyPem: string; authority: string }> = {};
  for (const env of envs) {
    environments[env] = { keyId: "KEYID12345", keyPem: TEST_PEM, authority: apns.authority };
  }
  const sender = openApns({
    teamId: "TEAM123456",
    topic: "build.kieran.pinomad",
    environments: environments as Parameters<typeof openApns>[0]["environments"],
  });
  // publicOrigin is the address the host dials — the register signs it.
  const port = await freePort();
  const relay = await startRelay({
    port,
    publicOrigin: `http://127.0.0.1:${port}`,
    allowedHosts: [],
    registerTimeoutMs: 300,
    accounts,
    push: sender,
  });
  defer(relay.close); // owns the APNs sender too
  return { relay, accounts, apns };
}

/**
 * A joined host: the data dir carries server.json and a hosts row bound to
 * the account before the link dials — written from the host's own relay/noise
 * keys, the same artifacts `pinomad join` produces.
 */
async function joinedHost(
  relay: Relay,
  accounts: Accounts,
  options: Omit<Parameters<typeof startFauxHost>[1], "dataDir" | "relay" | "remote">,
): Promise<{ host: OpenedHost; dataDir: string }> {
  const dataDir = await tempDir();
  defer(dataDir.remove);
  const relayKey = await loadRelayKey(dataDir.path);
  const hostKey = await loadHostKey(dataDir.path);
  const db = new DatabaseSync(accounts.dbPath);
  db.prepare(
    "INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, ?, 'test-host', 1, 1)",
  ).run(relayHostId(relayKey.publicKey), toBase64Url(hostKey.publicKey));
  db.close();
  const origin = relay.url.replace(/^ws/, "http");
  await writeServerConfig(dataDir.path, { origin });
  const host = await startFauxHost(defer, {
    ...options,
    dataDir: dataDir.path,
    remote: { port: await freePort() },
    relay: { origin, reconnectDelayMs: { min: 50, max: 200 } },
  });
  await waitForRelayState(host, "registered");
  return { host, dataDir: dataDir.path };
}

describe("push end to end", () => {
  it("delivers each APNs answer back over the control connection, classified per ADR §5", async () => {
    const answers = new Map<string, { status: number; body?: unknown }>([
      [TOKEN_GONE, { status: 410, body: { reason: "Unregistered", timestamp: Date.now() + 60_000 } }],
      [TOKEN_BAD, { status: 400, body: { reason: "BadDeviceToken" } }],
    ]);
    const { relay, accounts, apns } = await startServer((call) => answers.get(call.token) ?? { status: 200 });
    const { host } = await joinedHost(relay, accounts, {
      extensions: [question],
      answers: [QUESTION_STEP],
      push: { timers: new ManualTimers() },
    });
    const watcher = await connectTo(defer, host);

    const a = await pairDevice(defer, host, "ok");
    const b = await pairDevice(defer, host, "gone");
    const c = await pairDevice(defer, host, "bad");
    await a.client.controller.setPushToken({ apns: TOKEN_OK, environment: "production" });
    await b.client.controller.setPushToken({ apns: TOKEN_GONE, environment: "production" });
    await c.client.controller.setPushToken({ apns: TOKEN_BAD, environment: "production" });

    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await apns.waitForCalls(3);

    // Every request went to /3/device/<token> with the alert headers; the
    // payload carries only title/event data (ADR-0025 §2).
    for (const call of apns.calls) {
      expect(call.headers[":path"]).toBe(`/3/device/${call.token}`);
      expect(call.headers["apns-push-type"]).toBe("alert");
      expect(call.headers["apns-topic"]).toBe("build.kieran.pinomad");
      expect(call.headers["apns-expiration"]).toBeDefined();
      expect(call.headers["apns-collapse-id"]).toMatch(/^[0-9a-f]{32}$/);
      expect(call.payload).toMatchObject({
        aps: { alert: { title: "PiNomad conversation", body: "Waiting for your answer" } },
      });
    }

    // 410 with a timestamp after the registration → the token is dropped;
    // 400 BadDeviceToken and 200 leave it alone.
    await waitUntil(async () => (await registrations(host)).length === 2);
    const kept = (await registrations(host)).map((entry) => entry.token).sort();
    expect(kept).toEqual([TOKEN_BAD, TOKEN_OK].sort());
  });

  it("retries 429 and 5xx on the server-directed delay, and swaps the JWT after ExpiredProviderToken", async () => {
    const count: Record<string, number> = {};
    const { relay, accounts, apns } = await startServer((call) => {
      count[call.token] = (count[call.token] ?? 0) + 1;
      if (call.token === TOKEN_BUSY && count[call.token] === 1) {
        return { status: 429, body: { reason: "TooManyRequests" }, headers: { "retry-after": "30" } };
      }
      if (call.token === TOKEN_ERR && count[call.token] === 1) {
        return { status: 500, body: { reason: "InternalServerError" } };
      }
      if (call.token === TOKEN_JWT && count[call.token] === 1) {
        return { status: 403, body: { reason: "ExpiredProviderToken" } };
      }
      return { status: 200 };
    });
    const timers = new ManualTimers();
    const { host } = await joinedHost(relay, accounts, {
      extensions: [question],
      answers: [QUESTION_STEP],
      push: { timers },
    });
    const watcher = await connectTo(defer, host);
    const a = await pairDevice(defer, host, "a");
    const b = await pairDevice(defer, host, "b");
    const c = await pairDevice(defer, host, "c");
    await a.client.controller.setPushToken({ apns: TOKEN_BUSY, environment: "production" });
    await b.client.controller.setPushToken({ apns: TOKEN_ERR, environment: "production" });
    await c.client.controller.setPushToken({ apns: TOKEN_JWT, environment: "production" });

    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await apns.waitForCalls(3);
    // Three retry timers: 30 s (429 Retry-After), 5 s local backoff (403), 15 min (500).
    await waitUntil(() => timers.pending >= 3);

    timers.advance(30_000);
    await apns.waitForCalls(5);
    expect(count[TOKEN_BUSY]).toBe(2); // Retry-After 30 s won over the 5 s backoff
    expect(count[TOKEN_JWT]).toBe(2); // ExpiredProviderToken retried on the local backoff
    expect(count[TOKEN_ERR]).toBe(1); // the 500 still waits out its 15 minutes

    // The 403 retry carried a freshly signed provider token.
    const jwts = apns.calls.filter((call) => call.token === TOKEN_JWT).map((call) => call.headers.authorization);
    expect(jwts).toHaveLength(2);
    expect(jwts[0]).not.toBe(jwts[1]);

    timers.advance(15 * 60 * 1000);
    await apns.waitForCalls(6);
    expect(count[TOKEN_ERR]).toBe(2);

    // Everything settled: all registrations stay (no 410), all accepted.
    expect((await registrations(host)).map((entry) => entry.token).sort()).toEqual(
      [TOKEN_BUSY, TOKEN_ERR, TOKEN_JWT].sort(),
    );
  });

  it("keeps a new host silent and connected when the server declares no push", async () => {
    // No APNs configured on the server (the pre-push deployment's shape): the
    // registered frame declares nothing, so the host must never send `push`
    // and the control stays healthy.
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const accounts = await openAccounts({ dataDir: dataDir.path, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
    const port = await freePort();
    const relay = await startRelay({
      port,
      publicOrigin: `http://127.0.0.1:${port}`,
      allowedHosts: [],
      registerTimeoutMs: 300,
      accounts,
    });
    defer(relay.close);
    const timers = new ManualTimers();
    const { host } = await joinedHost(relay, accounts, {
      extensions: [question],
      answers: [QUESTION_STEP],
      push: { timers },
    });
    const { client } = await pairDevice(defer, host, "phone");
    await client.controller.setPushToken({ apns: TOKEN_OK, environment: "production" });
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");

    // "Push-capable, nothing configured" declares push: [] — the host treats
    // it as unavailable: no send, no retry timers, and the control was never
    // disturbed by an unknown-frame close.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(timers.pending).toBe(0);
    expect(host.relay?.state().status).toBe("registered");
    expect(await registrations(host)).toHaveLength(1);
  });

  it("an old host talks to a new server: registered still parses, the socket stays up", async () => {
    // The old-host case: `registered {push:[...]}` decodes fine on a peer that
    // ignores the field. A joined host with the sender never attached is that
    // peer — its control connection must stay healthy.
    const { relay, accounts } = await startServer();
    const { host } = await joinedHost(relay, accounts, {
      extensions: [question],
      answers: [QUESTION_STEP],
      // No push option at all: the sender never attaches — the "old host".
    });
    const watcher = await connectTo(defer, host);
    await startChat(watcher, "deploy?");
    await waitForView(watcher.view, (view) => view.organized.chats[0]?.summary.status === "needs-answer");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.relay?.state().status).toBe("registered");
  });
});
