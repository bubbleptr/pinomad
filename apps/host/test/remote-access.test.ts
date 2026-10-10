import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import { pickLanAddress } from "../src/gateway.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, freePort, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

/** The controller's pairing offer, unwrapped from its result frame. */
async function createPairing(client: RemoteDurable): Promise<{ url: string; expiresAt: number }> {
  return client.controller.createPairing();
}

function devicesOf(client: RemoteDurable) {
  return client.view.current().devices;
}

function connectDevice(host: OpenedHost, device: KeyPair, pairing?: { secret: string; name: string }): Promise<RemoteDurable> {
  return connectDeviceAt(host.remote!.url, host.remote!.hostKey, device, pairing);
}

function connectDeviceAt(
  target: string,
  hostKey: Uint8Array,
  device: KeyPair,
  pairing?: { secret: string; name: string },
): Promise<RemoteDurable> {
  const client = connectRemoteDurable({
    transport: secureWebSocketTransport({
      url: target,
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

/** Parse `#pair=<hostKey>.<secret>` off a createPairing url. */
function pairFrom(url: string): { hostKey: Uint8Array; secret: string } {
  const marker = "#pair=";
  const at = url.indexOf(marker);
  if (at < 0) throw new Error(`no pairing marker in ${url}`);
  const [key, secret] = url.slice(at + marker.length).split(".");
  return { hostKey: fromBase64Url(key!), secret: secret! };
}

describe("remote access", () => {
  // ADR-0020 §§2–4: no LAN listener, yet a paired device reaches the Noise
  // channel on the loopback port's /secure path — a same-machine client like
  // the desktop app never needs the token.
  it("pairs a device over the loopback secure channel when remote access is off", async () => {
    const host = await startFauxHost(defer, { answers: ["paired locally"] });
    expect(host.remote).toBeUndefined();
    const tokenClient = await connectTo(defer, host);

    const { url } = await createPairing(tokenClient);
    const port = new URL(host.url).port;
    expect(url.startsWith(`http://127.0.0.1:${port}/#pair=`)).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf("#") + 1));
    const target = params.get("url");
    expect(target).toBe(`ws://127.0.0.1:${port}/secure`);
    // pair= isn't the fragment's last field here, so a naive split would
    // swallow the url param into the secret.
    const [key, secret] = params.get("pair")!.split(".");
    const hostKey = fromBase64Url(key!);

    const device = generateKeyPair();
    const remote = await connectDeviceAt(target!, hostKey, device, { secret, name: "desktop" });
    expect(remote.view.current().connection).toBe("connected");

    await remote.controller.createConversation({ kind: "chat" }, "hello from desktop");
    await waitForView(remote.view, (view) => transcript(view.conversation!).at(-1)?.text === "paired locally");

    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    expect(devicesOf(tokenClient)[0]!.name).toBe("desktop");

    // A registered device reconnects without a pairing secret.
    await remote.close();
    const again = await connectDeviceAt(target!, hostKey, device);
    expect(again.view.current().connection).toBe("connected");
  });

  it("runs the Noise handshake on /secure without a token or an Origin check", async () => {
    const host = await startFauxHost(defer);
    const port = new URL(host.url).port;
    // An Origin the token path would reject must not matter here: the close
    // comes from the handshake (1008), not the admission gate (4401).
    const socket = new WebSocket(`ws://127.0.0.1:${port}/secure`, { origin: "app://pinomad" });
    const closed = once(socket, "close");
    socket.on("open", () => socket.send(new Uint8Array([1, 2, 3, 4])));
    expect((await closed)[0]).toBe(1008);
  });

  it("pairs a device and the client can drive conversations", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() }, answers: ["paired hello"] });
    expect(host.remote).toBeDefined();
    const tokenClient = await connectTo(defer, host);

    const { url, expiresAt } = await createPairing(tokenClient);
    expect(expiresAt).toBeGreaterThan(Date.now());
    const { hostKey, secret } = pairFrom(url);
    expect(hostKey).toEqual(host.remote!.hostKey);

    const device = generateKeyPair();
    const remote = await connectDevice(host, device, { secret, name: "test phone" });
    expect(remote.view.current().connection).toBe("connected");

    await remote.controller.createConversation({ kind: "chat" }, "hello from phone");
    await waitForView(remote.view, (view) => transcript(view.conversation!).at(-1)?.text === "paired hello");

    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    const [entry] = devicesOf(tokenClient);
    expect(entry!.name).toBe("test phone");
    expect(entry!.publicKey).toBe(toBase64Url(device.publicKey));
  });

  it("reconnects a registered device without pairing", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const tokenClient = await connectTo(defer, host);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const first = await connectDevice(host, device, { secret, name: "phone" });
    await first.close();

    const second = await connectDevice(host, device);
    expect(second.view.current().connection).toBe("connected");
  });

  it("rejects wrong, reused, expired, and absent pairing secrets", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort(), pairingTtlMs: 60 } });
    const tokenClient = await connectTo(defer, host);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);

    const wrong = generateKeyPair();
    await expect(connectDevice(host, wrong, { secret: "wrong", name: "x" })).rejects.toThrow();
    await expect(connectDevice(host, generateKeyPair())).rejects.toThrow();

    const device = generateKeyPair();
    await connectDevice(host, device, { secret, name: "phone" });
    // The offer is consumed: a second device presenting it must be refused.
    await expect(connectDevice(host, generateKeyPair(), { secret, name: "other" })).rejects.toThrow();

    // Expired: a fresh offer past its TTL.
    const { url: expiredUrl } = await createPairing(tokenClient);
    const { secret: expiredSecret } = pairFrom(expiredUrl);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(connectDevice(host, generateKeyPair(), { secret: expiredSecret, name: "late" })).rejects.toThrow();

    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    expect(devicesOf(tokenClient).map((entry) => entry.name)).toEqual(["phone"]);
  });

  it("accepts a registered device resending its pair payload (lost reply retry)", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const tokenClient = await connectTo(defer, host);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const first = await connectDevice(host, device, { secret, name: "phone" });
    await first.close();

    const retry = await connectDevice(host, device, { secret, name: "phone" });
    expect(retry.view.current().connection).toBe("connected");
  });

  it("revoking a device closes its live client and rejects reconnects", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const tokenClient = await connectTo(defer, host);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const remote = await connectDevice(host, device, { secret, name: "phone" });
    const key = toBase64Url(device.publicKey);

    await tokenClient.controller.revokeDevice(key);
    await waitForView(remote.view, (view) => view.connection === "closed");
    await expect(connectDevice(host, device)).rejects.toThrow();

    await waitForView(tokenClient.view, (view) => view.devices.length === 0);
  });

  it("keeps an established session alive past the handshake timeout", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort(), handshakeTimeoutMs: 100 } });
    const tokenClient = await connectTo(defer, host);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const remote = await connectDevice(host, device, { secret, name: "phone" });

    // The handshake deadline must not fire on a settled session: no reconnect
    // dips within three timeouts, and calls still get results.
    const dips: string[] = [];
    const unsubscribe = remote.view.subscribe(() => {
      const { connection } = remote.view.current();
      if (connection !== "connected") dips.push(connection);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dips).toHaveLength(0);
    expect((await remote.controller.createPairing()).url).toContain("#pair=");
    unsubscribe();
  });

  it("still closes a socket that never sends the handshake", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort(), handshakeTimeoutMs: 100 } });
    const socket = new WebSocket(host.remote!.url);
    const [code] = await once(socket, "close");
    expect(code).toBe(1008);
  });

  it("does not serve token auth or garbage on the remote port", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const socket = new WebSocket(`${host.remote!.url}?token=${host.token}`);
    const closed = once(socket, "close");
    socket.on("open", () => socket.send(JSON.stringify({ type: "subscribe", stream: "tasks" })));
    const [code] = await closed;
    expect(code).toBe(1008);

    const garbage = new WebSocket(host.remote!.url);
    const garbageClosed = once(garbage, "close");
    garbage.on("open", () => garbage.send(new Uint8Array([1, 2, 3, 4])));
    const [garbageCode] = await garbageClosed;
    expect(garbageCode).toBe(1008);
  });

  it("keeps the same host key across a restart; a paired device reconnects without pairing", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const port = await freePort();
    const first = await startFauxHost(defer, { dataDir: dir.path, remote: { port } });
    const tokenClient = await connectTo(defer, first);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const paired = await connectDevice(first, device, { secret, name: "phone" });
    const key = first.remote!.hostKey;
    await paired.close();
    await first.close();

    const reopened = await startFauxHost(defer, { dataDir: dir.path, remote: { port } });
    expect(reopened.remote!.hostKey).toEqual(key);
    const remote = await connectDevice(reopened, device);
    expect(remote.view.current().connection).toBe("connected");
  });

  it("serves the built web client safely", async () => {
    const webRoot = await tempDir();
    defer(webRoot.remove);
    await mkdir(join(webRoot.path, "assets"), { recursive: true });
    await writeFile(join(webRoot.path, "index.html"), "<html>pinomad</html>");
    await writeFile(join(webRoot.path, "assets", "app.js"), "console.log(1)");

    const host = await startFauxHost(defer, { webRoot: webRoot.path, remote: { port: await freePort() } });
    const http = `http://127.0.0.1:${new URL(host.remote!.url).port}`;

    const index = await fetch(`${http}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("html");
    expect(await index.text()).toContain("pinomad");

    const js = await fetch(`${http}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");

    // Extensionless routes get the SPA fallback.
    const route = await fetch(`${http}/some/route`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("pinomad");

    // Traversal — encoded or not — and missing files are 404. fetch() would
    // normalize the path before sending, so traversal goes over raw HTTP.
    const raw = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const request = httpRequest({ port: new URL(host.remote!.url).port, path, host: "127.0.0.1" });
        request.once("response", (response) => resolve(response.statusCode ?? 0));
        request.once("error", reject);
        request.end();
      });
    expect(await raw("/%2e%2e/%2e%2e/etc/passwd")).toBe(404);
    expect(await raw("/../package.json")).toBe(404);
    expect((await fetch(`${http}/missing.js`)).status).toBe(404);
    expect((await fetch(`${http}/`, { method: "POST" })).status).toBe(405);
  });

  it("picks a real LAN address over tunnel interfaces", () => {
    const iface = (address: string, internal = false) => [{ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: "" }];
    expect(
      pickLanAddress({
        lo0: iface("127.0.0.1", true),
        utun4: iface("172.19.0.1"),
        en0: iface("192.168.1.20"),
      }),
    ).toBe("192.168.1.20");
    expect(pickLanAddress({ lo0: iface("127.0.0.1", true), utun4: iface("172.19.0.1") })).toBeUndefined();
    // The fake-ip/benchmark range never wins, even on an en-named interface.
    expect(pickLanAddress({ en0: iface("198.18.0.1"), lo0: iface("127.0.0.1", true) })).toBeUndefined();
    // Link-local never wins either.
    expect(pickLanAddress({ en1: iface("169.254.10.1"), utun4: iface("172.19.0.1") })).toBeUndefined();
    // A non-virtual, non-en interface with a private address is a valid fallback.
    expect(pickLanAddress({ lo0: iface("127.0.0.1", true), ifb0: iface("10.0.0.2") })).toBe("10.0.0.2");
  });

  it("reports the web client missing when webRoot is absent", async () => {
    const host = await startFauxHost(defer, { remote: { port: await freePort() } });
    const http = `http://127.0.0.1:${new URL(host.remote!.url).port}`;
    const response = await fetch(`${http}/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("bun run build");
  });
});
