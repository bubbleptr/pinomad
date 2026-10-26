// Spawned by rtc-node.test.ts in plain Node: the vitest worker pool does not
// deliver node-datachannel's native thread callbacks, so the real WebRTC path
// runs in a normal process, exactly like the host does in production.
import { once } from "node:events";
import { WebSocket } from "ws";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import {
  fromBase64Url,
  SECURE_PROLOGUE,
  SIGNAL_PROLOGUE,
  toBase64Url,
} from "@pinomad/protocol/secure-channel.ts";
import { RawSecureClient, RtcDataPeer } from "../rtc-support.ts";

const [hostUrl, token] = process.argv.slice(2);
if (hostUrl === undefined || token === undefined) {
  console.error("usage: rtc-client.ts <ws url> <token>");
  process.exit(2);
}

const fail = (error: unknown): never => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exit(1);
};

/** A plain token connection: hello, then one call. */
async function tokenCall<M extends keyof CallMethods>(
  method: M,
  args: CallMethods[M]["args"],
): Promise<CallMethods[M]["result"]> {
  const socket = new WebSocket(`${hostUrl}?token=${encodeURIComponent(token)}`);
  await once(socket, "open");
  let id = 1;
  return await new Promise((resolve, reject) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      if (frame.type === "hello") {
        socket.send(JSON.stringify({ type: "call", id, method, args }));
        return;
      }
      if (frame.type === "result" && frame.id === id) {
        socket.close();
        if (frame.ok) resolve(frame.value as CallMethods[M]["result"]);
        else reject(new Error(frame.error));
      }
    });
    socket.on("error", reject);
    socket.on("close", (code) => {
      if (code !== 1000) reject(new Error(`token socket closed with ${code}`));
    });
  });
}

function pairingDetails(url: string): { hostKey: Uint8Array; secret: string; target: string } {
  const params = new URLSearchParams(url.slice(url.indexOf("#") + 1));
  const pair = params.get("pair");
  const target = params.get("url");
  if (pair === null || target === null) return fail("not a pairing link");
  const [key, secret] = pair.split(".");
  if (key === undefined || secret === undefined) return fail("malformed pairing marker");
  return { hostKey: fromBase64Url(key), secret, target };
}

async function main(): Promise<void> {
  const pairing = pairingDetails((await tokenCall("createPairing", {})).url);
  const device = generateKeyPair();
  const deviceKey = toBase64Url(device.publicKey);

  const business = await RawSecureClient.open({
    url: pairing.target,
    hostKey: pairing.hostKey,
    device,
    prologue: SECURE_PROLOGUE,
    pair: { secret: pairing.secret, name: "rtc node" },
  });
  const signal = await RawSecureClient.open({
    url: pairing.target,
    hostKey: pairing.hostKey,
    device,
    prologue: SIGNAL_PROLOGUE,
  });

  if (JSON.stringify(signal.hello.rtc) !== JSON.stringify({ stun: [], signalOnly: true })) {
    fail("signal hello did not carry the RTC capability");
  }
  if (signal.hello.session !== undefined || signal.hello.models !== undefined) {
    fail("signal hello was not minimal");
  }

  // Business connection → offer → DataChannel → Noise → business hello.
  const businessPeer = await RtcDataPeer.create({ hostKey: pairing.hostKey, device, stun: [] });
  const businessAnswer = await business.call("rtcOffer", { attempt: "business-1", sdp: businessPeer.offerSdp });
  const businessHello = await businessPeer.accept(businessAnswer.sdp);
  if (businessHello.protocol.minor !== PROTOCOL.minor) fail("business hello has the wrong minor");
  if (businessHello.session === undefined) fail("business hello has no session");
  const ping = await businessPeer.call("ping", { id: "dc-ping" });
  if (ping.id !== "dc-ping") fail("ping did not echo its id");

  // Signal connection → offer → its own DataChannel, then close the signal
  // connection: the completed DC belongs to the business connection now.
  const firstSignalPeer = await RtcDataPeer.create({ hostKey: pairing.hostKey, device, stun: [] });
  const firstSignalAnswer = await signal.call("rtcOffer", { attempt: "signal-1", sdp: firstSignalPeer.offerSdp });
  await firstSignalPeer.accept(firstSignalAnswer.sdp);
  signal.close();
  await signal.closed;
  const afterSignal = await firstSignalPeer.call("ping", { id: "after-signal" });
  if (afterSignal.id !== "after-signal") fail("closing the signal connection killed its completed peer");

  // Open the revocation target before the large settings update, so its hello
  // stays small; the update itself only changes what later connections read.
  const revokedSignal = await RawSecureClient.open({
    url: pairing.target,
    hostKey: pairing.hostKey,
    device,
    prologue: SIGNAL_PROLOGUE,
  });

  // A multi-record frame in both directions without involving a model: the
  // updateSettings call carries ~2 MiB to the host, and the settings snapshot
  // carries the same string back over the DataChannel.
  const big = `stun:${"x".repeat(2 * 1024 * 1024)}`;
  await businessPeer.call("updateSettings", { patch: { rtcStun: [big] } });
  await businessPeer.sendFrame({ type: "subscribe", stream: "settings" });
  const snapshot = await businessPeer.nextFrame(
    (frame) => frame.type === "snapshot" && frame.stream === "settings",
    60_000,
  );
  if (snapshot.type !== "snapshot") return fail("not a settings snapshot");
  const settings = snapshot.value as { rtcStun?: readonly string[] };
  const largeMatch = Array.isArray(settings.rtcStun) && settings.rtcStun.length === 1 && settings.rtcStun[0] === big;
  if (!largeMatch) fail("the large frame did not round-trip byte for byte");

  // Revocation must close the live signal connection and the two completed
  // DataChannels (whose business connections are the device's lifecycle
  // entries). Incomplete peers are covered by the fake-peer test.
  await tokenCall("revokeDevice", { publicKey: deviceKey });
  const revokedSignalCode = await revokedSignal.closed;
  const businessCode = await business.closed;
  const completedPeersClosed = await Promise.race([
    Promise.all([
      businessPeer.closed.then(() => true),
      firstSignalPeer.closed.then(() => true),
    ]).then((closed) => closed.every(Boolean)),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (revokedSignalCode !== 4401) fail(`revoked signal closed with ${revokedSignalCode}`);
  if (businessCode !== 4401) fail(`revoked business connection closed with ${businessCode}`);
  if (!completedPeersClosed) fail("revocation left a completed DataChannel open");

  console.log(
    JSON.stringify({
      ok: true,
      protocolMinor: PROTOCOL.minor,
      businessMinor: businessHello.protocol.minor,
      ping: ping.id,
      afterSignal: afterSignal.id,
      largeBytes: big.length,
      largeMatch,
      falseSends: businessPeer.falseSends,
      revokedSignalCode,
      businessCode,
      completedPeersClosed,
    }),
  );
  businessPeer.close();
  firstSignalPeer.close();
  business.close();
  // Native peer handles can keep the event loop alive after close; the verdict
  // is already printed and the parent waits for this process to exit.
  process.exit(0);
}

await main().catch(fail);
