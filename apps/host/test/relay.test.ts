import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import { startRelay } from "@pinomad/relay/src/relay.ts";
import { loadRelayKey } from "../src/devices.ts";
import type { OpenedHost } from "../src/host.ts";
import type { RelayLinkState } from "../src/relay-link.ts";
import { connectTo, freePort, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

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

/** A relay wired to `dir`'s relay key, on its own port; returns it and the device URL. */
async function startTestRelay(dir: string, options?: { allow?: readonly string[] }) {
  const port = await freePort();
  const key = await loadRelayKey(dir);
  const hostId = relayHostId(key.publicKey);
  const origin = `http://127.0.0.1:${port}`;
  const relay = await startRelay({
    port,
    publicOrigin: origin,
    allowedHosts: options?.allow ?? [hostId],
  });
  defer(() => relay.close());
  return { relay, port, origin, hostId, deviceUrl: `ws://127.0.0.1:${port}/c/${hostId}` };
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

  it("prefers the relay over the LAN listener in pairing links", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { origin } = await startTestRelay(dir.path);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      remote: { port: await freePort() },
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    await waitForRelayState(host, "registered");
    const tokenClient = await connectTo(defer, host);
    const { url } = await tokenClient.controller.createPairing();
    expect(url.startsWith(`${origin}/#pair=`)).toBe(true);
  });

  it("re-registers after a relay restart and carries devices again", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const { relay, port, origin, deviceUrl } = await startTestRelay(dir.path);
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

    await relay.close();
    await waitForRelayState(host, "connecting");
    const restarted = await startRelay({ port, publicOrigin: origin, allowedHosts: [relayHostId((await loadRelayKey(dir.path)).publicKey)] });
    defer(() => restarted.close());
    await waitForRelayState(host, "registered");

    const second = await connectDevice(deviceUrl, fromBase64Url(hostKey), device);
    expect(second.view.current().connection).toBe("connected");
  });

  it("reports a rejected hostId while the host keeps serving local clients", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    // The relay allowlists somebody else: this host's hostId gets a 4603.
    const { origin, hostId } = await startTestRelay(dir.path, { allow: ["x".repeat(43)] });
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin, reconnectDelayMs: QUICK_RECONNECT },
    });
    const state = await waitForRelayState(host, "rejected");
    if (state.status !== "rejected") throw new Error("unreachable");
    expect(state.reason).toContain(hostId);
    expect(state.reason).toContain("--allow-host");

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
