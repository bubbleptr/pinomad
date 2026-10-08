import { once } from "node:events";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import {
  decodeRelayToHost,
  encodeRelayFrame,
  RELAY_CLOSE,
  relayHostId,
  signRelayChallenge,
  type HostToRelay,
} from "@pinomad/protocol/relay.ts";
import { startRelay, type Relay, type RelayOptions } from "../src/relay.ts";

const ORIGIN = "https://relay.example.com";
const hostKeys = ed25519.keygen();
const hostId = relayHostId(hostKeys.publicKey);

const relays: Relay[] = [];
const clients = new Set<WebSocket>();
afterEach(async () => {
  for (const client of clients) client.terminate();
  clients.clear();
  for (const relay of relays.splice(0)) await relay.close();
});

function start(options?: Partial<RelayOptions>): Promise<Relay> {
  return startRelay({
    port: 0,
    publicOrigin: ORIGIN,
    allowedHosts: [hostId],
    acceptTimeoutMs: 150,
    registerTimeoutMs: 150,
    ...options,
  }).then((relay) => (relays.push(relay), relay));
}

/** Just connects; the caller decides which events to await and in what order. */
function connect(relay: Relay, path: string, options?: ClientOptions): WebSocket {
  const socket = new WebSocket(`${relay.url}${path}`, options);
  clients.add(socket);
  return socket;
}

const asText = (data: unknown): string => (data as Buffer).toString();

const nextControl = async (socket: WebSocket): Promise<ReturnType<typeof decodeRelayToHost>> =>
  decodeRelayToHost(asText((await once(socket, "message"))[0]));

const closeEvent = (socket: WebSocket): Promise<[number, string]> =>
  once(socket, "close").then(([code, reason]) => [code as number, (reason as Buffer).toString()]);

type KeyPair = ReturnType<typeof ed25519.keygen>;

/**
 * Opens a control connection and answers the challenge. The message listener
 * goes up before `open` resolves because the relay sends `challenge` during
 * the upgrade — attaching it after would race and lose it.
 */
async function openControl(
  relay: Relay,
  keys: KeyPair = hostKeys,
  options?: { origin?: string; signature?: string },
): Promise<WebSocket> {
  const socket = connect(relay, "/host");
  const challengeP = once(socket, "message");
  await once(socket, "open");
  const challenge = decodeRelayToHost(asText((await challengeP)[0]));
  if (challenge.t !== "challenge") throw new Error("expected challenge");
  const register: HostToRelay = {
    t: "register",
    hostId: relayHostId(keys.publicKey),
    signature:
      options?.signature ??
      signRelayChallenge(keys.secretKey, {
        relayOrigin: options?.origin ?? ORIGIN,
        hostId: relayHostId(keys.publicKey),
        nonce: challenge.nonce,
      }),
  };
  socket.send(encodeRelayFrame(register));
  return socket;
}

/** openControl plus awaiting `registered` — the happy path. */
async function registerHost(relay: Relay, keys?: KeyPair): Promise<WebSocket> {
  const socket = await openControl(relay, keys);
  expect(await nextControl(socket)).toEqual({ t: "registered" });
  return socket;
}

describe("relay", () => {
  it("splices a device to an accepted host connection, buffering pre-accept messages", async () => {
    const relay = await start();
    const control = await registerHost(relay);

    // `incoming` is sent during the device upgrade, so listen before it opens.
    const incomingP = once(control, "message");
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    // The real device sends Noise handshake message 1 the moment it opens.
    device.send(Buffer.from([1, 2, 3]));

    const incoming = decodeRelayToHost(asText((await incomingP)[0]));
    if (incoming.t !== "incoming") throw new Error("expected incoming");

    const host = connect(relay, `/accept/${incoming.connId}`);
    const bufferedP = once(host, "message");
    await once(host, "open");
    const [buffered, bufferedBinary] = (await bufferedP) as [Buffer, boolean];
    expect(bufferedBinary).toBe(true);
    expect([...buffered]).toEqual([1, 2, 3]);

    const textP = once(host, "message");
    device.send("hello");
    const [text, textBinary] = (await textP) as [Buffer, boolean];
    expect(textBinary).toBe(false);
    expect(text.toString()).toBe("hello");

    const backP = once(device, "message");
    host.send(Buffer.from([9, 8]));
    const [back, backBinary] = (await backP) as [Buffer, boolean];
    expect(backBinary).toBe(true);
    expect([...back]).toEqual([9, 8]);

    const downP = once(device, "message");
    host.send("down");
    const [down, downBinary] = (await downP) as [Buffer, boolean];
    expect(downBinary).toBe(false);
    expect(down.toString()).toBe("down");
  });

  it("rejects a signature over a different relay origin with 4601", async () => {
    const relay = await start();
    const socket = await openControl(relay, hostKeys, { origin: "https://evil.example.com" });
    expect(await closeEvent(socket)).toEqual([RELAY_CLOSE.badSignature, ""]);
  });

  it("rejects a garbage signature with 4601", async () => {
    const relay = await start();
    const socket = await openControl(relay, hostKeys, { signature: "AAAA" });
    expect(await closeEvent(socket)).toEqual([RELAY_CLOSE.badSignature, ""]);
  });

  it("rejects a well-signed hostId outside the allowlist with 4603", async () => {
    const relay = await start();
    const socket = await openControl(relay, ed25519.keygen());
    expect(await closeEvent(socket)).toEqual([RELAY_CLOSE.hostNotAllowed, ""]);
  });

  it("closes a device for an unregistered hostId with 4604", async () => {
    const relay = await start();
    const device = connect(relay, `/c/${relayHostId(ed25519.keygen().publicKey)}`);
    await once(device, "open");
    expect(await closeEvent(device)).toEqual([RELAY_CLOSE.hostOffline, ""]);
  });

  it("times out a pending device the host never accepts", async () => {
    const relay = await start();
    await registerHost(relay);
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    expect(await closeEvent(device)).toEqual([RELAY_CLOSE.acceptTimeout, ""]);
  });

  it("rejects unknown and already-used connIds with 4605", async () => {
    const relay = await start();
    const control = await registerHost(relay);

    const bogus = connect(relay, `/accept/${"A".repeat(22)}`);
    await once(bogus, "open");
    expect(await closeEvent(bogus)).toEqual([RELAY_CLOSE.unknownConnection, ""]);

    const incomingP = once(control, "message");
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    device.send(Buffer.from([1]));
    const incoming = decodeRelayToHost(asText((await incomingP)[0]));
    if (incoming.t !== "incoming") throw new Error("expected incoming");

    const first = connect(relay, `/accept/${incoming.connId}`);
    await once(first, "open");
    const reused = connect(relay, `/accept/${incoming.connId}`);
    await once(reused, "open");
    expect(await closeEvent(reused)).toEqual([RELAY_CLOSE.unknownConnection, ""]);
  });

  it("propagates a host data close to the device, code and reason intact", async () => {
    const relay = await start();
    const control = await registerHost(relay);
    const incomingP = once(control, "message");
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    const incoming = decodeRelayToHost(asText((await incomingP)[0]));
    if (incoming.t !== "incoming") throw new Error("expected incoming");
    const host = connect(relay, `/accept/${incoming.connId}`);
    await once(host, "open");

    const deviceClosed = closeEvent(device);
    host.close(4001, "bye");
    expect(await deviceClosed).toEqual([4001, "bye"]);
  });

  it("propagates a device close to the host data socket", async () => {
    const relay = await start();
    const control = await registerHost(relay);
    const incomingP = once(control, "message");
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    const incoming = decodeRelayToHost(asText((await incomingP)[0]));
    if (incoming.t !== "incoming") throw new Error("expected incoming");
    const host = connect(relay, `/accept/${incoming.connId}`);
    await once(host, "open");

    const hostClosed = closeEvent(host);
    device.close(4002, "gone");
    expect(await hostClosed).toEqual([4002, "gone"]);
  });

  it("replaces a duplicate registration with 4609 and notifies the new control", async () => {
    const relay = await start();
    const first = await registerHost(relay);
    const second = await registerHost(relay);
    expect(await closeEvent(first)).toEqual([RELAY_CLOSE.replaced, ""]);

    const incomingP = once(second, "message");
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    expect(decodeRelayToHost(asText((await incomingP)[0])).t).toBe("incoming");
  });

  it("closes pending devices when the host control goes away", async () => {
    const relay = await start();
    const control = await registerHost(relay);
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    control.close();
    expect(await closeEvent(device)).toEqual([RELAY_CLOSE.hostOffline, ""]);
  });

  it("terminates a socket that stops ponging", async () => {
    const relay = await start({ pingIntervalMs: 50 });
    await registerHost(relay);
    const device = connect(relay, `/c/${hostId}`, { autoPong: false });
    await once(device, "open");
    const [code] = await closeEvent(device);
    // terminate() shows up client-side as an abnormal 1006, not a clean close.
    expect(code).toBe(1006);
  });

  it("closes a device that sends an oversized message with 1009", async () => {
    const relay = await start();
    await registerHost(relay);
    const device = connect(relay, `/c/${hostId}`);
    await once(device, "open");
    device.send(new Uint8Array(200 * 1024));
    expect(await closeEvent(device)).toEqual([1009, ""]);
  });

  it("closes a control that sends garbage before registering with 1008", async () => {
    const relay = await start();
    const socket = connect(relay, "/host");
    const challengeP = once(socket, "message");
    await once(socket, "open");
    await challengeP;
    socket.send("nope");
    const [code] = await closeEvent(socket);
    expect(code).toBe(1008);
  });
});
