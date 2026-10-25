import { stat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { parsePairingLink } from "@pinomad/protocol/pairing-link.ts";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import { startRelay, type Relay } from "@pinomad/server/src/relay.ts";
import { loadRelayKey } from "../src/devices.ts";
import type { OpenedHost } from "../src/host.ts";
import { Published, type HostValue } from "../src/host-value.ts";
import { startRelayLink, type AccountOfferResult, type RelayLink, type RelayLinkState } from "../src/relay-link.ts";
import { connectTo, freePort, openBoundAccounts, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

/** Poll a getter until it holds — for things with no event to await. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Poll the link's state getter — there is no event to wait on. */
async function waitForRelayState(
  host: OpenedHost,
  status: RelayLinkState["status"],
  timeoutMs = 10_000,
): Promise<RelayLinkState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = host.relay!.state();
    if (state.status === status) return state;
    if (Date.now() > deadline) throw new Error(`relay state is ${state.status}, wanted ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** `pair=<hostKey>.<secret>` and `url=<device target>` off a pairing link's fragment. */
function pairParams(url: string): { hostKey: string; secret: string; target: string } {
  const params = new URLSearchParams(url.slice(url.indexOf("#") + 1));
  const [hostKey, secret] = params.get("pair")!.split(".");
  return { hostKey: hostKey!, secret: secret!, target: params.get("url")! };
}

/**
 * A relay on its own port with `dir`'s relay key bound to an account (unless
 * `bound: false`), plus the device URL. `stop` and `restart` cycle it on the
 * same port and accounts directory; cleanup stops whichever one is live.
 */
async function startTestRelay(dir: string, options?: { bound?: boolean }) {
  const port = await freePort();
  const key = await loadRelayKey(dir);
  const hostId = relayHostId(key.publicKey);
  const origin = `http://127.0.0.1:${port}`;
  const server = await tempDir();
  defer(server.remove);
  let relay: Relay | undefined;
  let stopping: Promise<void> | undefined;
  const restart = async (): Promise<void> => {
    relay = await startRelay({
      port,
      publicOrigin: origin,
      accounts: await openBoundAccounts(server.path, options?.bound === false ? "x".repeat(43) : hostId),
    });
    stopping = undefined;
  };
  const stop = (): Promise<void> => (stopping ??= relay!.close());
  await restart();
  defer(stop);
  return { stop, restart, port, origin, hostId, deviceUrl: `ws://127.0.0.1:${port}/c/${hostId}` };
}

function connectDevice(
  url: string,
  hostKey: Uint8Array,
  device: KeyPair,
  pairing?: { secret: string; name: string },
): Promise<RemoteDurable> {
  const client = connectRemoteDurable({
    transport: secureWebSocketTransport({
      url,
      hostKey,
      device,
      ...(pairing === undefined ? {} : { pairing }),
    }),
    reconnectDelayMs: { min: 100, max: 200 },
  });
  return client.then((remote) => {
    defer(() => remote.close());
    return remote;
  });
}

const QUICK_RECONNECT = { min: 50, max: 200 };

/**
 * A minimal stand-in for the server side of /host: answers the upgrade with a
 * challenge, captures the register, then lets the test drive frames. Used to
 * exercise the relay link's pairing answers and push requests without a whole
 * accounts server. `push` declares APNs environments on `registered`
 * (ADR-0025 §3) and `features` its feature strings — omit either to stand in
 * for a server that predates the declaration. `holdRegistered` stops the
 * auto-answer so a test can open the register → registered window itself.
 */
async function fakeServer(options?: {
  push?: readonly string[];
  features?: readonly string[];
  holdRegistered?: boolean;
}): Promise<{
  port: number;
  origin: string;
  /** Resolves with the host's first register frame once it arrives. */
  register: Promise<Record<string, unknown>>;
  /** Every register received, reconnects included. */
  registers(): readonly Record<string, unknown>[];
  send(frame: object): void;
  nextMessage(): Promise<Record<string, unknown>>;
  /** Queued frames not yet taken by nextMessage. */
  messages(): readonly Record<string, unknown>[];
  /** Every non-register frame received, consumed or not. */
  frames(): readonly Record<string, unknown>[];
  /** Change what the next `registered` declares — a redeployed older instance. */
  setPush(push: readonly string[] | undefined): void;
  setFeatures(features: readonly string[] | undefined): void;
  closeControl(): void;
}> {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  defer(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const port = (wss.address() as AddressInfo).port;
  let socket: import("ws").WebSocket | undefined;
  let push = options?.push;
  let features = options?.features;
  const registers: Record<string, unknown>[] = [];
  const frames: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  const seen = new Promise<Record<string, unknown>>((resolve) => {
    wss.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (data) => {
        const frame = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
        if (frame.t === "register") {
          registers.push(frame);
          resolve(frame);
          if (options?.holdRegistered !== true) {
            ws.send(
              JSON.stringify({
                t: "registered",
                ...(push === undefined ? {} : { push }),
                ...(features === undefined ? {} : { features }),
              }),
            );
          }
          return;
        }
        frames.push(frame);
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(frame);
        else messages.push(frame);
      });
      ws.send(JSON.stringify({ t: "challenge", nonce: "test-nonce" }));
    });
  });
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    register: seen,
    registers: () => registers,
    send(frame) {
      socket?.send(JSON.stringify(frame));
    },
    nextMessage() {
      const queued = messages.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
    messages: () => messages,
    frames: () => frames,
    setPush(next) {
      push = next;
    },
    setFeatures(next) {
      features = next;
    },
    closeControl() {
      socket?.close();
      socket = undefined;
    },
  };
}

describe("relay link pairing answers", () => {
  const linkWith = async (
    server: Awaited<ReturnType<typeof fakeServer>>,
    accountOffer?: () => Promise<AccountOfferResult>,
  ): Promise<RelayLinkState["status"][]> => {
    const states: RelayLinkState["status"][] = [];
    const link = startRelayLink({
      origin: server.origin,
      signingKey: ed25519.keygen(),
      noisePublicKey: generateKeyPair().publicKey,
      accept: () => {},
      onStateChange: (state) => states.push(state.status),
      reconnectDelayMs: QUICK_RECONNECT,
      ...(accountOffer === undefined ? {} : { accountOffer }),
    });
    defer(() => link.close());
    await until(() => states[0] === "registered");
    return states;
  };

  it("declares the pairing feature only when an offer source is wired", async () => {
    const wired = await fakeServer();
    await linkWith(wired, async () => ({ ok: false, reason: "not_joined" }));
    expect((await wired.register).features).toEqual(["pairing"]);

    const plain = await fakeServer();
    await linkWith(plain);
    expect((await plain.register).features).toBeUndefined();
  });

  it("answers pairing-request with the minted offer or the refusal reason", async () => {
    const server = await fakeServer();
    const endpointSet = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://relay.example.com/c/host" },
        { transport: "webSocket" as const, role: "direct" as const, url: "ws://192.168.1.20:7422/" },
      ],
    };
    let reply: AccountOfferResult = { ok: true, secret: "the-secret", expiresAt: 4242, endpointSet };
    await linkWith(server, async () => reply);
    await server.register;

    const answerP = server.nextMessage();
    server.send({ t: "pairing-request", requestId: "req-1" });
    expect(await answerP).toEqual({ t: "pairing", requestId: "req-1", secret: "the-secret", expiresAt: 4242, endpointSet });

    reply = { ok: false, reason: "disabled" };
    const refusedP = server.nextMessage();
    server.send({ t: "pairing-request", requestId: "req-2" });
    expect(await refusedP).toEqual({ t: "pairing-refused", requestId: "req-2", reason: "disabled" });

    // A host that can only offer the legacy shape sends no set at all.
    reply = { ok: true, secret: "legacy", expiresAt: 7 };
    const legacyP = server.nextMessage();
    server.send({ t: "pairing-request", requestId: "req-3" });
    expect(await legacyP).toEqual({ t: "pairing", requestId: "req-3", secret: "legacy", expiresAt: 7 });
  });

  it("keeps unsupported sets on the legacy path and refuses malformed or empty ones", async () => {
    const server = await fakeServer();
    const relay = { transport: "webSocket" as const, role: "relay" as const, url: "wss://relay.example.com/c/host" };
    let reply: AccountOfferResult = {
      ok: true,
      secret: "schema",
      expiresAt: 1,
      endpointSet: { schemaVersion: 2, endpoints: [relay] } as unknown as EndpointSet,
    };
    await linkWith(server, async () => reply);
    await server.register;
    const ask = async (requestId: string): Promise<Record<string, unknown>> => {
      const answer = server.nextMessage();
      server.send({ t: "pairing-request", requestId });
      return answer;
    };

    // Unknown schema / transport are "do not know" (ADR-0032 §8): keep the
    // legacy answer and leave the field out, exactly like an old host.
    expect(await ask("schema")).toEqual({ t: "pairing", requestId: "schema", secret: "schema", expiresAt: 1 });

    reply = {
      ok: true,
      secret: "transport",
      expiresAt: 2,
      endpointSet: { schemaVersion: 1, endpoints: [{ ...relay, transport: "quic" }] } as unknown as EndpointSet,
    };
    expect(await ask("transport")).toEqual({
      t: "pairing",
      requestId: "transport",
      secret: "transport",
      expiresAt: 2,
    });

    reply = {
      ok: true,
      secret: "malformed",
      expiresAt: 3,
      endpointSet: { schemaVersion: 1, endpoints: null } as unknown as EndpointSet,
    };
    expect(await ask("malformed")).toEqual({
      t: "pairing-refused",
      requestId: "malformed",
      reason: "invalid_endpoint",
    });

    reply = { ok: true, secret: "empty", expiresAt: 4, endpointSet: { schemaVersion: 1, endpoints: [] } };
    expect(await ask("empty")).toEqual({ t: "pairing-refused", requestId: "empty", reason: "invalid_endpoint" });

    // A refused answer never poisons the next ask.
    reply = { ok: true, secret: "good", expiresAt: 5 };
    expect(await ask("good")).toEqual({ t: "pairing", requestId: "good", secret: "good", expiresAt: 5 });
  });

  it("refuses requests when no offer source exists", async () => {
    const server = await fakeServer();
    await linkWith(server);
    await server.register;
    const answerP = server.nextMessage();
    server.send({ t: "pairing-request", requestId: "req-9" });
    expect(await answerP).toEqual({ t: "pairing-refused", requestId: "req-9", reason: "unavailable" });
  });
});

describe("relay link push", () => {
  const notification = {
    title: "PiNomad conversation",
    body: "Finished",
    collapseId: "ab".repeat(16),
    hostKey: "host-key",
    conversationId: 1,
  };
  const request = { token: "aa".repeat(32), environment: "production" as const, notification };

  const startLink = (server: Awaited<ReturnType<typeof fakeServer>>) => {
    const link = startRelayLink({
      origin: server.origin,
      signingKey: ed25519.keygen(),
      noisePublicKey: generateKeyPair().publicKey,
      accept: () => {},
      reconnectDelayMs: QUICK_RECONNECT,
    });
    defer(() => link.close());
    return link;
  };
  const registered = (link: ReturnType<typeof startLink>) => until(() => link.state().status === "registered");

  it("sends a push frame and resolves the server's verdict", async () => {
    const server = await fakeServer({ push: ["production"] });
    const link = startLink(server);
    await registered(link);

    const sentP = server.nextMessage();
    const verdictP = link.sendPush(request);
    const frame = (await sentP) as { t: string; requestId: string; notification: unknown };
    expect(frame).toMatchObject({ t: "push", token: request.token, environment: "production", notification });

    server.send({ t: "push-result", requestId: frame.requestId, result: "accepted", reason: "ok" });
    expect(await verdictP).toEqual({ result: "accepted", reason: "ok" });
  });

  it("sends nothing when the declaration is absent or misses the environment (ADR-0025 §3)", async () => {
    const server = await fakeServer({ push: ["development"] });
    const link = startLink(server);
    await registered(link);

    // Declared, but not this environment: unavailable, and no frame leaves.
    expect(await link.sendPush(request)).toEqual({
      result: "unavailable",
      reason: "environment production not declared",
    });

    // A server with no APNs configured declares an empty list; a pre-push
    // server declares nothing at all. Both are unavailable — never sent,
    // never retried (the frame would end the old decoder's connection).
    server.setPush([]);
    server.closeControl();
    await until(() => link.state().status === "connecting");
    await registered(link);
    expect(await link.sendPush(request)).toEqual({
      result: "unavailable",
      reason: "environment production not declared",
    });
    server.setPush(undefined);
    server.closeControl();
    await until(() => link.state().status === "connecting");
    await registered(link);
    expect(await link.sendPush(request)).toEqual({
      result: "unavailable",
      reason: "server does not declare push",
    });
    expect(server.messages().filter((frame) => frame.t === "push")).toHaveLength(0);
  });

  it("settles an in-flight request as retry when the control drops", async () => {
    const server = await fakeServer({ push: ["production"] });
    const link = startLink(server);
    await registered(link);

    const sentP = server.nextMessage();
    const verdictP = link.sendPush(request);
    await sentP;
    server.closeControl();
    expect((await verdictP).result).toBe("retry");

    // A send while disconnected is retry — the capability re-reads on
    // reconnect, so this is a transient condition, unlike "never declared".
    await until(() => link.state().status === "connecting");
    expect((await link.sendPush(request)).result).toBe("retry");
  });
});

describe("relay link host name (issue #212)", () => {
  const nameSource = (initial: string): Published<string | undefined> =>
    new Published<string | undefined>(initial, (a, b) => a === b);

  const startLink = (
    server: Awaited<ReturnType<typeof fakeServer>>,
    name?: HostValue<string | undefined>,
  ): RelayLink => {
    const link = startRelayLink({
      origin: server.origin,
      signingKey: ed25519.keygen(),
      noisePublicKey: generateKeyPair().publicKey,
      accept: () => {},
      ...(name === undefined ? {} : { hostName: name }),
      reconnectDelayMs: QUICK_RECONNECT,
    });
    defer(() => link.close());
    return link;
  };
  const registered = (link: RelayLink) => until(() => link.state().status === "registered");

  it("reports the effective name on register — and none without a source", async () => {
    const named = await fakeServer();
    const link = startLink(named, nameSource("omarchy"));
    expect((await named.register).name).toBe("omarchy");
    await registered(link);

    const plain = await fakeServer();
    startLink(plain);
    expect((await plain.register).name).toBeUndefined();
  });

  it("sends a name frame on rename only when the connection declared it", async () => {
    const server = await fakeServer({ features: ["name"] });
    const name = nameSource("one");
    const link = startLink(server, name);
    await registered(link);
    const sent = server.nextMessage();
    name.set("two");
    expect(await sent).toEqual({ t: "name", name: "two" });
  });

  it("tops up a rename that raced the register → registered window", async () => {
    const server = await fakeServer({ holdRegistered: true });
    const name = nameSource("one");
    startLink(server, name);
    await server.register; // carried "one"; registered is still held
    name.set("two"); // renamed inside the window — nothing can be sent yet
    server.send({ t: "registered", features: ["name"] });
    expect(await server.nextMessage()).toEqual({ t: "name", name: "two" });
  });

  it("stays silent on undeclared connections and drops the capability on reconnect", async () => {
    const server = await fakeServer({ features: ["name"] });
    const name = nameSource("one");
    const link = startLink(server, name);
    await registered(link);
    name.set("two");
    expect(await server.nextMessage()).toEqual({ t: "name", name: "two" });

    // A redeployed older server: the next registered declares nothing, so the
    // capability must not carry over from the previous connection.
    server.setFeatures(undefined);
    server.closeControl();
    await until(() => server.registers().length === 2);
    await registered(link);
    // The register re-reported the current name; a rename now goes nowhere.
    expect(server.registers()[1]!.name).toBe("two");
    name.set("three");
    // The pairing probe proves every earlier frame already arrived — no name.
    const probe = server.nextMessage();
    server.send({ t: "pairing-request", requestId: "probe" });
    expect(await probe).toEqual({ t: "pairing-refused", requestId: "probe", reason: "unavailable" });
    expect(server.frames().filter((frame) => frame.t === "name")).toEqual([{ t: "name", name: "two" }]);
  });
});

describe("relay link", () => {
  it("pairs a device through the relay end to end, then reconnects it without pairing", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { origin, deviceUrl, hostId } = await startTestRelay(dir.path);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
      answers: ["paired through relay"],
    });
    expect(host.remote).toBeUndefined();
    await waitForRelayState(host, "registered");
    const tokenClient = await connectTo(defer, host);

    const { url } = await tokenClient.controller.createPairing();
    expect(url.startsWith(`${origin}/#pair=`)).toBe(true);
    const { hostKey, secret, target } = pairParams(url);
    expect(target).toBe(deviceUrl);
    expect(url).toContain(`url=${encodeURIComponent(deviceUrl)}`);
    expect(hostId).toBe(host.relay!.hostId);

    const device = generateKeyPair();
    const remote = await connectDevice(target, fromBase64Url(hostKey), device, { secret, name: "relay phone" });
    expect(remote.view.current().connection).toBe("connected");

    await remote.controller.createConversation({ kind: "chat" }, "hello via relay");
    await waitForView(remote.view, (view) => transcript(view.conversation!).at(-1)?.text === "paired through relay");
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    expect(tokenClient.view.current().devices[0]!.publicKey).toBe(toBase64Url(device.publicKey));

    await remote.close();
    // A registered device reconnects through the relay with plain IK.
    const second = await connectDevice(deviceUrl, fromBase64Url(hostKey), device);
    expect(second.view.current().connection).toBe("connected");
  });

  it("falls back to the direct legacy url when the loopback relay is filtered", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { origin } = await startTestRelay(dir.path);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      remote: { port: 0, publicUrl: "http://192.168.1.20:7422" },
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    await waitForRelayState(host, "registered");
    const tokenClient = await connectTo(defer, host);
    const { url } = await tokenClient.controller.createPairing();
    // The loopback relay cannot reach a phone, so the direct address owns the
    // legacy url; old clients still get one usable path.
    expect(url.startsWith("http://192.168.1.20:7422/#pair=")).toBe(true);

    const parsed = parsePairingLink(url)!;
    expect(parsed.url).toBe("ws://192.168.1.20:7422/");
    expect(parsed.endpointSet).toEqual({
      schemaVersion: 1,
      endpoints: [{ transport: "webSocket", role: "direct", url: "ws://192.168.1.20:7422/" }],
    });
  });

  it("re-registers after a relay restart and carries devices again", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { stop, restart, origin, deviceUrl } = await startTestRelay(dir.path);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    await waitForRelayState(host, "registered");
    const tokenClient = await connectTo(defer, host);
    const { url } = await tokenClient.controller.createPairing();
    const { hostKey, secret } = pairParams(url);
    const device = generateKeyPair();
    const first = await connectDevice(deviceUrl, fromBase64Url(hostKey), device, { secret, name: "phone" });
    await first.close();

    await stop();
    await waitForRelayState(host, "connecting");
    // The binding survives the restart in the server's database.
    await restart();
    await waitForRelayState(host, "registered");

    const second = await connectDevice(deviceUrl, fromBase64Url(hostKey), device);
    expect(second.view.current().connection).toBe("connected");
  });

  it("reports a rejected hostId while the host keeps serving local clients", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    // The server binds somebody else: this host's hostId gets a 4603.
    const { origin, hostId } = await startTestRelay(dir.path, { bound: false });
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    const state = await waitForRelayState(host, "rejected");
    if (state.status !== "rejected") throw new Error("unreachable");
    expect(state.reason).toContain(hostId);
    expect(state.reason).toContain("pinomad join");

    const tokenClient = await connectTo(defer, host);
    await tokenClient.controller.createConversation({ kind: "chat" }, "still local");
    await waitForView(tokenClient.view, (view) => transcript(view.conversation!).length > 0);
  });

  it("disconnects a relay-carried device when it is revoked", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { origin } = await startTestRelay(dir.path);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    await waitForRelayState(host, "registered");
    const tokenClient = await connectTo(defer, host);
    const { url } = await tokenClient.controller.createPairing();
    const { hostKey, secret, target } = pairParams(url);
    const device = generateKeyPair();
    const remote = await connectDevice(target, fromBase64Url(hostKey), device, { secret, name: "phone" });
    expect(remote.view.current().connection).toBe("connected");

    await tokenClient.controller.revokeDevice(toBase64Url(device.publicKey));
    await waitForView(remote.view, (view) => view.connection === "closed");
  });
});

describe("loadRelayKey", () => {
  it("creates a stable 0600 Ed25519 key, even for concurrent first calls", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const [a, b] = await Promise.all([loadRelayKey(dir.path), loadRelayKey(dir.path)]);
    expect(toBase64Url(a.secretKey)).toBe(toBase64Url(b.secretKey));
    const again = await loadRelayKey(dir.path);
    expect(toBase64Url(again.secretKey)).toBe(toBase64Url(a.secretKey));
    expect(relayHostId(a.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const path = join(dir.path, "relay-key");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const written = await loadRelayKey(dir.path);
    expect(toBase64Url(written.secretKey)).toBe(toBase64Url(a.secretKey));
  });
});

describe("relay link resilience", () => {
  it("reports state transitions: registered, connecting on relay loss, registered again", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { stop, restart, port, origin } = await startTestRelay(dir.path);
    const states: RelayLinkState["status"][] = [];
    const link = startRelayLink({
      origin,
      signingKey: await loadRelayKey(dir.path),
      noisePublicKey: generateKeyPair().publicKey,
      accept: () => {},
      onStateChange: (state) => states.push(state.status),
      reconnectDelayMs: { min: 20, max: 50 },
    });
    defer(() => link.close());
    await until(() => states.length === 1);

    await stop();
    await until(() => states.length === 2);

    // Hold the port so at least two reconnect dials fail before the relay
    // comes back; destroy-on-accept fails the ws upgrade immediately.
    let dials = 0;
    const blocker = createServer((socket) => {
      dials += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    await until(() => dials >= 2);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    await restart();
    await until(() => states.length === 3);
    expect(states).toEqual(["registered", "connecting", "registered"]);
  });

  it("times out a dial that never answers the upgrade and reconnects", async () => {
    // A server that accepts TCP and stays silent: the ws handshake hangs.
    const sockets: Socket[] = [];
    let dials = 0;
    const server = createServer((socket) => {
      dials += 1;
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    defer(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const link = startRelayLink({
      origin: `http://127.0.0.1:${port}`,
      signingKey: ed25519.keygen(),
      noisePublicKey: generateKeyPair().publicKey,
      accept: () => {},
      reconnectDelayMs: { min: 10, max: 10 },
      pingIntervalMs: 20,
    });
    defer(() => link.close());
    // Without a handshake deadline + open-state guard the ping interval throws
    // on the CONNECTING socket and the dial hangs forever; with them the link
    // abandons it inside one interval and redials.
    await until(() => dials >= 2);
    await link.close();
  });

  it("terminates spliced relay sockets when the host closes", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { origin, deviceUrl } = await startTestRelay(dir.path);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    await waitForRelayState(host, "registered");
    const tokenClient = await connectTo(defer, host);
    const { url } = await tokenClient.controller.createPairing();
    const { hostKey, secret } = pairParams(url);

    // Drive the transport directly so the socket's own close is observable.
    const device = generateKeyPair();
    const closed = new Promise<number>((resolve) => {
      secureWebSocketTransport({
        url: deviceUrl,
        hostKey: fromBase64Url(hostKey),
        device,
        pairing: { secret, name: "phone" },
      }).open({ message: () => {}, closed: (code) => resolve(code) });
    });
    // Registration lands after the splice, so the accept socket is watched.
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);

    await host.close();
    const code = await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("device socket never closed")), 2000)),
    ]);
    // The link terminates the data socket; the relay forwards that as 1001.
    expect(code).toBe(1001);
  });
});
