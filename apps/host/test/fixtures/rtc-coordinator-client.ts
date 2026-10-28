// Spawned by rtc-coordinator-node.test.ts in a plain Node process: vitest's
// worker pool does not deliver node-datachannel's native thread callbacks.
// The real coordinator connects to a real host over WebSocket, upgrades to a
// real libdatachannel Peer, calls and subscribes, then loses the DataChannel
// and reconnects over WebSocket.
import { once } from "node:events";
import { WebSocket } from "ws";
import type { CallMethods } from "@pinomad/protocol/frames.ts";
import { candidatePlan } from "@pinomad/protocol/remote-candidates.ts";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { parsePairingLink } from "@pinomad/protocol/pairing-link.ts";
import { fromBase64Url, secureWebSocketTransport } from "@pinomad/protocol/secure-channel.ts";
import { NodeRtcPeer } from "../rtc-support.ts";

const [hostUrl, token] = process.argv.slice(2);
if (hostUrl === undefined || token === undefined) {
  console.error("usage: rtc-coordinator-client.ts <ws url> <token>");
  process.exit(2);
}

const fail = (error: unknown): never => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
  process.exit(1);
};

async function tokenCall<M extends keyof CallMethods>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
  const socket = new WebSocket(`${hostUrl}?token=${encodeURIComponent(token)}`);
  await once(socket, "open");
  return await new Promise((resolve, reject) => {
    const id = 1;
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { type?: string; id?: number; ok?: boolean; value?: unknown; error?: string };
      if (frame.type === "hello") socket.send(JSON.stringify({ type: "call", id, method, args }));
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

async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 30_000,
  details?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const why = details === undefined ? "" : ` (${JSON.stringify(details())})`;
  throw new Error(`timed out waiting for ${what}${why}`);
}

class Platform {
  last: NodeRtcPeer | undefined;
  async createPeer(stun: readonly string[]): Promise<NodeRtcPeer> {
    this.last = await NodeRtcPeer.create(stun);
    return this.last;
  }
}

async function main(): Promise<void> {
  const pairing = parsePairingLink((await tokenCall("createPairing", {})).url);
  if (pairing === undefined) return fail("not a pairing link");
  const hostKey = fromBase64Url(pairing.hostKey);
  const device = generateKeyPair();
  let invite: { secret: string; name: string } | undefined = { secret: pairing.secret, name: "rtc coordinator" };
  const candidates = candidatePlan(pairing.url, pairing.endpointSet);
  const platform = new Platform();
  const remote: RemoteDurable = await connectRemoteDurable({
    candidates,
    legacyUrl: pairing.url,
    openTransport: (candidate) =>
      secureWebSocketTransport({
        url: candidate.url,
        hostKey,
        device,
        ...(invite === undefined ? {} : { pairing: invite }),
        ...(invite === undefined ? {} : { onPaired: () => { invite = undefined; } }),
      }),
    rtc: {
      platform,
      hostKey,
      device,
      signalOnlyHint: true,
    },
    reconnectDelayMs: { min: 100, max: 500 },
  });
  try {
    await waitFor("ready", () => remote.view.current().connection === "connected");
    if (remote.rtcDiagnostics().path === "p2p") throw new Error("upgraded before the initial WebSocket was ready");
    await waitFor(
      "P2P handoff",
      () => remote.rtcDiagnostics().path === "p2p",
      30_000,
      () => remote.rtcDiagnostics(),
    );
    const models = remote.view.current().models;
    const created = await remote.controller.createPairing();
    if (typeof created.url !== "string" || created.url === "") throw new Error("createPairing did not return a url");
    const settings = remote.view.current().settings;
    if (settings === null) throw new Error("the P2P connection did not receive the settings stream");
    const selected = remote.rtcDiagnostics().selectedPair;
    const peer = platform.last;
    if (peer === undefined) throw new Error("no DataChannel peer was created");
    peer.close();
    await waitFor("WebSocket fallback", () => remote.rtcDiagnostics().path !== "p2p" && remote.view.current().connection === "connected");
    console.log(JSON.stringify({
      ok: true,
      models: models.length,
      pairingUrl: created.url.startsWith("http") || created.url.startsWith("pinomad://"),
      selectedCandidateType: selected === undefined
        ? null
        : `${selected.local.type ?? "unknown"} ↔ ${selected.remote.type ?? "unknown"}`,
      fallbackPath: remote.rtcDiagnostics().path,
      connection: remote.view.current().connection,
    }));
    // Native peer handles can keep Node alive after the verdict; the parent
    // already has what it needs.
    process.exit(0);
  } finally {
    remote.close();
  }
}

await main().catch(fail);
