import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import { DevicesDoc, RevocationsDoc } from "../src/devices.ts";
import { pickLanAddress } from "../src/gateway.ts";
import type { OpenedHost } from "../src/host.ts";
import { removeServerConfig, writeServerConfig } from "../src/server-config.ts";
import { connectTo, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

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
    // The offer rode a loopback link: source "local" (ADR-0020 §4).
    expect(devicesOf(tokenClient)[0]!.source).toBe("local");

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
    const host = await startFauxHost(defer, { remote: { port: 0 }, answers: ["paired hello"] });
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
    expect(entry!.source).toBe("qr");
  });

  it("reconnects a registered device without pairing", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
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
    // The offer lifetime is what this test asserts, so Date is frozen: time
    // advances only where the test says so, never by how long a refused
    // handshake or a busy scheduler took between minting and using the offer.
    vi.useFakeTimers({ toFake: ["Date"] });
    defer(() => {
      vi.useRealTimers();
    });
    const host = await startFauxHost(defer, { remote: { port: 0, pairingTtlMs: 60 } });
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

    // Expired: a fresh offer, then the clock crosses its TTL.
    const { url: expiredUrl } = await createPairing(tokenClient);
    const { secret: expiredSecret } = pairFrom(expiredUrl);
    vi.setSystemTime(Date.now() + 61);
    await expect(connectDevice(host, generateKeyPair(), { secret: expiredSecret, name: "late" })).rejects.toThrow();

    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    expect(devicesOf(tokenClient).map((entry) => entry.name)).toEqual(["phone"]);
  });

  it("accepts a registered device resending its pair payload (lost reply retry)", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
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
    const host = await startFauxHost(defer, { remote: { port: 0 } });
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
    const host = await startFauxHost(defer, { remote: { port: 0, handshakeTimeoutMs: 100 } });
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
    const host = await startFauxHost(defer, { remote: { port: 0, handshakeTimeoutMs: 100 } });
    const socket = new WebSocket(host.remote!.url);
    const [code] = await once(socket, "close");
    expect(code).toBe(1008);
  });

  it("does not serve token auth or garbage on the remote port", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
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
    const first = await startFauxHost(defer, { dataDir: dir.path, remote: { port: 0 } });
    const tokenClient = await connectTo(defer, first);
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const paired = await connectDevice(first, device, { secret, name: "phone" });
    const key = first.remote!.hostKey;
    await paired.close();
    await first.close();

    const reopened = await startFauxHost(defer, { dataDir: dir.path, remote: { port: 0 } });
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

    const host = await startFauxHost(defer, { webRoot: webRoot.path, remote: { port: 0 } });
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
    const host = await startFauxHost(defer, { remote: { port: 0 } });
    const http = `http://127.0.0.1:${new URL(host.remote!.url).port}`;
    const response = await fetch(`${http}/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("bun run build");
  });
});

// ADR-0022 §6 host-side admission: an account offer is minted under the joined
// server's binding (server.json), and the one-commit admission re-checks it
// against the revocation list, the acceptAccountDevices switch, and the
// binding as it stands at that instant.
describe("account-source admission", () => {
  const SERVER = "https://server.example.com";

  async function joinedHost(): Promise<{ host: OpenedHost; dataDir: string }> {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, { dataDir: dir.path, remote: { port: 0 } });
    await writeServerConfig(dir.path, { origin: SERVER });
    return { host, dataDir: dir.path };
  }

  it("admits a server-vouched device as source account and tells online clients; qr pairing stays quiet", async () => {
    const { host } = await joinedHost();
    const tokenClient = await connectTo(defer, host);

    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    await connectDevice(host, generateKeyPair(), { secret, name: "qr phone" });
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    // A notice, had one been broadcast, reaches a client before any later call's result.
    await tokenClient.controller.createPairing();
    expect(tokenClient.view.current().notices).toEqual([]);

    const offer = await host.createAccountOffer();
    expect(offer).toBeDefined();
    const laptop = generateKeyPair();
    const remote = await connectDevice(host, laptop, { secret: offer!.secret, name: "account laptop" });
    expect(remote.view.current().connection).toBe("connected");

    await waitForView(tokenClient.view, (view) => view.devices.length === 2);
    const entry = devicesOf(tokenClient).find((each) => each.publicKey === toBase64Url(laptop.publicKey));
    expect(entry?.source).toBe("account");
    await waitForView(tokenClient.view, (view) =>
      view.notices.some((notice) => notice.message === 'New device "account laptop" joined through your account'),
    );
    // The newcomer was not yet a client when the notice went out.
    expect(remote.view.current().notices).toEqual([]);
  });

  it("refuses account offers for a revoked key; a fresh scan re-pairs and clears the revocation", async () => {
    const { host } = await joinedHost();
    const tokenClient = await connectTo(defer, host);

    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const device = generateKeyPair();
    const key = toBase64Url(device.publicKey);
    await connectDevice(host, device, { secret, name: "phone" });
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);

    await tokenClient.controller.revokeDevice(key);
    await waitForView(tokenClient.view, (view) => view.devices.length === 0);

    const offer = await host.createAccountOffer();
    await expect(connectDevice(host, device, { secret: offer!.secret, name: "phone" })).rejects.toThrow();
    expect((await host.harness.snapshot(RevocationsDoc, BACKGROUND_CONTEXT))?.revoked).toContain(key);

    // The user scanned again on purpose: pairing succeeds and forgives the revocation.
    const { url: rescan } = await createPairing(tokenClient);
    const { secret: rescanSecret } = pairFrom(rescan);
    const rejoined = await connectDevice(host, device, { secret: rescanSecret, name: "phone" });
    expect(rejoined.view.current().connection).toBe("connected");
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    expect((await host.harness.snapshot(RevocationsDoc, BACKGROUND_CONTEXT))?.revoked ?? []).not.toContain(key);
  });

  it("refuses outstanding and newly minted account offers once acceptAccountDevices is off", async () => {
    const { host } = await joinedHost();
    const tokenClient = await connectTo(defer, host);
    const minted = await host.createAccountOffer();

    await tokenClient.controller.updateSettings({ acceptAccountDevices: false });
    await waitForView(tokenClient.view, (view) => view.settings?.acceptAccountDevices === false);

    // The switch-off revoked the in-flight offer before the client saw it.
    await expect(connectDevice(host, generateKeyPair(), { secret: minted!.secret, name: "x" })).rejects.toThrow();
    const fresh = await host.createAccountOffer();
    await expect(connectDevice(host, generateKeyPair(), { secret: fresh!.secret, name: "y" })).rejects.toThrow();

    await tokenClient.controller.updateSettings({ acceptAccountDevices: true });
    await waitForView(tokenClient.view, (view) => view.settings?.acceptAccountDevices === true);
    const offer = await host.createAccountOffer();
    const remote = await connectDevice(host, generateKeyPair(), { secret: offer!.secret, name: "z" });
    expect(remote.view.current().connection).toBe("connected");
  });

  it("refuses account offers minted under a binding that no longer stands", async () => {
    const { host, dataDir } = await joinedHost();
    await connectTo(defer, host);

    const swapped = await host.createAccountOffer();
    await writeServerConfig(dataDir, { origin: "https://other.example.com" });
    await expect(connectDevice(host, generateKeyPair(), { secret: swapped!.secret, name: "x" })).rejects.toThrow();

    // Re-joining the same origin is a new binding: the offer must stay dead.
    await writeServerConfig(dataDir, { origin: SERVER });
    await expect(connectDevice(host, generateKeyPair(), { secret: swapped!.secret, name: "y" })).rejects.toThrow();

    const orphaned = await host.createAccountOffer();
    await removeServerConfig(dataDir);
    await expect(connectDevice(host, generateKeyPair(), { secret: orphaned!.secret, name: "y" })).rejects.toThrow();
    // Left entirely, the host mints no account offers at all.
    expect(await host.createAccountOffer()).toBeUndefined();
  });

  it("runs normally on a server.json that predates bindings, but mints no account offers", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    // Only ever possible on a dev checkout between join and this change: a
    // file with `origin` but no `binding`.
    await writeFile(join(dir.path, "server.json"), JSON.stringify({ origin: SERVER }));
    const host = await startFauxHost(defer, { dataDir: dir.path, remote: { port: 0 } });
    const tokenClient = await connectTo(defer, host);
    expect(await host.createAccountOffer()).toBeUndefined();

    // QR pairing is unaffected.
    const { url } = await createPairing(tokenClient);
    const { secret } = pairFrom(url);
    const remote = await connectDevice(host, generateKeyPair(), { secret, name: "phone" });
    expect(remote.view.current().connection).toBe("connected");
  });

  // A taken port must reject startup. ws re-emits the http server's listen
  // error on a WebSocketServer that has no listener: attached before listen,
  // that turned EADDRINUSE into an uncaught exception and a hung startup.
  it.each([
    { listener: "loopback", address: "127.0.0.1", options: (port: number) => ({ port }) },
    { listener: "remote", address: "0.0.0.0", options: (port: number) => ({ remote: { port } }) },
  ])("rejects startup when the $listener port is taken", async ({ address, options }) => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, address, resolve));
    defer(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const { port } = taken.address() as AddressInfo;
    await expect(startFauxHost(defer, options(port))).rejects.toMatchObject({ code: "EADDRINUSE" });
  }, 5_000);

  it("still connects a device registered before sources existed", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
    const device = generateKeyPair();
    // A record written by a host that predated sources: no `source` field.
    await host.harness.commit(async (tx) => {
      (await tx.doc(DevicesDoc)).devices.push({ publicKey: toBase64Url(device.publicKey), name: "old phone", pairedAt: 1 });
    }, BACKGROUND_CONTEXT);

    const remote = await connectDevice(host, device);
    expect(remote.view.current().connection).toBe("connected");
    const tokenClient = await connectTo(defer, host);
    await waitForView(tokenClient.view, (view) => view.devices.length === 1);
    expect(devicesOf(tokenClient)[0]!.source).toBeUndefined();
  });
});
