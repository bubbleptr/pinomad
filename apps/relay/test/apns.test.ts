// The APNs sender (ADR-0025 §1-2, §5): env-var config loading, the ES256
// provider token, one HTTP/2 session per environment, and the verdict
// classification — all against a fake h2c APNs, never the real endpoints.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PushNotification } from "@pinomad/protocol/relay.ts";
import { loadApnsConfig, openApns, type ApnsSender } from "../src/apns.ts";
import { fakeApns, type FakeApns } from "./apns-fake.ts";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PEM = privateKey.export({ format: "pem", type: "pkcs8" }) as string;

const NOTIFICATION: PushNotification = {
  title: "PiNomad conversation",
  body: "Finished",
  collapseId: "ab".repeat(16),
  hostKey: "host-key",
  conversationId: 7,
};
const TOKEN = "aa".repeat(32);

const servers: FakeApns[] = [];
const senders: ApnsSender[] = [];
afterEach(async () => {
  for (const sender of senders.splice(0)) await sender.close();
  for (const server of servers.splice(0)) await server.close();
});

const startApns = async (
  responder?: Parameters<typeof fakeApns>[0],
  envs: Record<string, { authority?: string }> = { production: {} },
): Promise<{ apns: ApnsSender; fake: FakeApns }> => {
  const fake = await fakeApns(responder);
  servers.push(fake);
  const environments: Record<string, { keyId: string; keyPem: string; authority?: string }> = {};
  for (const [name, extra] of Object.entries(envs)) {
    environments[name] = {
      keyId: "KEYID12345",
      keyPem: TEST_PEM,
      authority: extra.authority ?? fake.authority,
    };
  }
  const apns = openApns({
    teamId: "TEAM123456",
    topic: "build.kieran.pinomad",
    environments: environments as Parameters<typeof openApns>[0]["environments"],
  });
  senders.push(apns);
  return { apns, fake };
};

const send = (apns: ApnsSender, overrides?: Partial<Parameters<ApnsSender["send"]>[0]>) =>
  apns.send({ token: TOKEN, environment: "production", notification: NOTIFICATION, ...overrides });

describe("loadApnsConfig", () => {
  const base = { PINOMAD_SERVER_APNS_TEAM_ID: "TEAM123456", PINOMAD_SERVER_APNS_TOPIC: "build.kieran.pinomad" };

  it("returns undefined without a team id or topic, and only fully-set environments", () => {
    expect(loadApnsConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(loadApnsConfig({ PINOMAD_SERVER_APNS_TEAM_ID: "T" } as NodeJS.ProcessEnv)).toBeUndefined();

    const config = loadApnsConfig({
      ...base,
      PINOMAD_SERVER_APNS_PRODUCTION_KEY_ID: "K1",
      PINOMAD_SERVER_APNS_PRODUCTION_KEY: TEST_PEM,
      // Half-configured development: dropped.
      PINOMAD_SERVER_APNS_DEVELOPMENT_KEY_ID: "K2",
    } as NodeJS.ProcessEnv);
    expect(config?.teamId).toBe("TEAM123456");
    expect(config?.topic).toBe("build.kieran.pinomad");
    expect(config?.environments.production?.keyId).toBe("K1");
    expect(config?.environments.development).toBeUndefined();
  });

  it("unescapes PEM newlines the way env-var UIs mangle them", () => {
    const config = loadApnsConfig({
      ...base,
      PINOMAD_SERVER_APNS_PRODUCTION_KEY_ID: "K1",
      PINOMAD_SERVER_APNS_PRODUCTION_KEY: TEST_PEM.replace(/\n/g, "\\n"),
    } as NodeJS.ProcessEnv);
    expect(config?.environments.production?.keyPem).toBe(TEST_PEM.trim());
  });
});

describe("openApns", () => {
  it("posts the alert payload with provider-token auth and the APNs headers", async () => {
    const { apns, fake } = await startApns();
    expect(apns.environments).toEqual(["production"]);

    expect(await send(apns)).toEqual({ result: "accepted", reason: "ok" });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.token).toBe(TOKEN);
    expect(call.headers["apns-push-type"]).toBe("alert");
    expect(call.headers["apns-topic"]).toBe("build.kieran.pinomad");
    expect(call.headers["apns-collapse-id"]).toBe(NOTIFICATION.collapseId);
    expect(Number(call.headers["apns-expiration"])).toBeGreaterThan(Date.now() / 1000 + 3500);
    // The provider token is a three-part ES256 JWT carrying the key id.
    const authorization = String(call.headers.authorization);
    expect(authorization.startsWith("bearer ")).toBe(true);
    const [header] = authorization.slice("bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(call.payload).toEqual({
      aps: {
        alert: { title: NOTIFICATION.title, body: NOTIFICATION.body },
        sound: "default",
        "thread-id": NOTIFICATION.collapseId,
      },
      hostKey: NOTIFICATION.hostKey,
      conversationId: NOTIFICATION.conversationId,
    });
  });

  it("classifies APNs answers per ADR-0025 §5", async () => {
    const answers = new Map<string, { status: number; body?: unknown }>([
      ["410-token", { status: 410, body: { reason: "Unregistered", timestamp: 1729 } }],
      ["bad-token", { status: 400, body: { reason: "BadDeviceToken" } }],
      ["wrong-topic", { status: 400, body: { reason: "DeviceTokenNotForTopic" } }],
      ["busy-token", { status: 429, body: { reason: "TooManyRequests" } }],
      ["err-token", { status: 500, body: { reason: "InternalServerError" } }],
    ]);
    const { apns } = await startApns((call) => answers.get(call.token) ?? { status: 200 });

    expect(await send(apns, { token: "410-token" })).toEqual({
      result: "unregistered",
      reason: "Unregistered",
      unregisteredAt: 1729,
    });
    expect(await send(apns, { token: "bad-token" })).toEqual({ result: "rejected", reason: "BadDeviceToken" });
    expect(await send(apns, { token: "wrong-topic" })).toEqual({ result: "rejected", reason: "DeviceTokenNotForTopic" });
    expect(await send(apns, { token: "busy-token" })).toEqual({ result: "retry", reason: "TooManyRequests" });
    expect((await send(apns, { token: "err-token" })).result).toBe("retry");
    const errVerdict = await send(apns, { token: "err-token" });
    expect(errVerdict.result === "retry" && errVerdict.retryAfterMs).toBe(15 * 60 * 1000);
  });

  it("passes a Retry-After header through on 429", async () => {
    const { apns } = await startApns(() => ({
      status: 429,
      body: { reason: "TooManyRequests" },
      headers: { "retry-after": "30" },
    }));
    const verdict = await send(apns);
    expect(verdict).toEqual({ result: "retry", reason: "TooManyRequests", retryAfterMs: 30_000 });
  });

  it("signs a fresh provider token after ExpiredProviderToken, and the retry goes through", async () => {
    let expired = true;
    const { apns, fake } = await startApns(() =>
      expired ? { status: 403, body: { reason: "ExpiredProviderToken" } } : { status: 200 },
    );

    expect(await send(apns)).toEqual({ result: "retry", reason: "ExpiredProviderToken" });
    const firstJwt = String(fake.calls[0]!.headers.authorization);
    expired = false;
    expect(await send(apns)).toEqual({ result: "accepted", reason: "ok" });
    // The retry carried a newly signed token — never the expired one.
    expect(String(fake.calls[1]!.headers.authorization)).not.toBe(firstJwt);
  });

  it("rejects an oversized payload without calling APNs", async () => {
    const { apns, fake } = await startApns();
    const verdict = await send(apns, {
      notification: { ...NOTIFICATION, title: "x".repeat(5000) },
    });
    expect(verdict).toEqual({ result: "rejected", reason: "PayloadTooLarge" });
    expect(fake.calls).toHaveLength(0);
  });

  it("rebuilds the session after a GOAWAY", async () => {
    const { apns, fake } = await startApns();
    expect(await send(apns)).toEqual({ result: "accepted", reason: "ok" });
    expect(fake.sessions).toHaveLength(1);

    fake.sessions[0]!.goaway();
    // The next send waits for a fresh session — poll it into existence.
    const deadline = Date.now() + 5_000;
    let verdict;
    for (;;) {
      verdict = await send(apns);
      if (verdict.result === "accepted") break;
      if (Date.now() > deadline) throw new Error(`send never recovered: ${JSON.stringify(verdict)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.sessions.length).toBeGreaterThanOrEqual(2);
  });

  it("drops an environment whose key fails to parse", async () => {
    const fake = await fakeApns();
    servers.push(fake);
    const apns = openApns({
      teamId: "TEAM123456",
      topic: "t",
      environments: { production: { keyId: "K", keyPem: "not a pem", authority: fake.authority } },
    });
    senders.push(apns);
    expect(apns.environments).toEqual([]);
    expect(await send(apns)).toEqual({ result: "unavailable", reason: "environment not configured" });
  });
});
