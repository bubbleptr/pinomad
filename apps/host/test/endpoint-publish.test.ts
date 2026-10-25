import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { parsePairingLink } from "@pinomad/protocol/pairing-link.ts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { printPairing } from "../src/cli/pair.ts";
import { loadHostKey } from "../src/devices.ts";
import { remoteEndpointCandidates, validateRelayTarget } from "../src/gateway.ts";
import { relayWsBase } from "../src/relay-link.ts";
import { connectTo, startFauxHost, tempDir, useCleanups } from "./support.ts";

// The advertised LAN address is rewritten between reads; a host that caches
// the startup value keeps publishing the first one (ADR-0032 §2).
const lan = vi.hoisted(() => ({ address: "192.168.1.20" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () => ({
      en0: [
        {
          address: lan.address,
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: `${lan.address}/24`,
        },
      ],
    }),
  };
});

const defer = useCleanups();

type Hello = Extract<ServerFrame, { type: "hello" }>;

async function readHello(args: {
  readonly url: string;
  readonly hostKey: Uint8Array;
  readonly device: ReturnType<typeof generateKeyPair>;
  readonly pairing?: { readonly secret: string; readonly name: string };
}): Promise<Hello> {
  const frames: ServerFrame[] = [];
  const connection = secureWebSocketTransport(args).open({
    message: (text) => frames.push(JSON.parse(text) as ServerFrame),
    closed: () => {},
  });
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      const hello = frames.find((frame): frame is Hello => frame.type === "hello");
      if (hello !== undefined) return hello;
      if (Date.now() > deadline) throw new Error("host sent no hello");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    connection.close();
  }
}

describe("remote endpoint candidates", () => {
  const HOST_ID = "A".repeat(43);
  const RELAY = { origin: "https://relay.example.com", hostId: HOST_ID };
  const DIRECT = { advertiseUrl: "https://192.168.1.20:7422" };

  it("publishes relay then direct for reachable sources", () => {
    expect(remoteEndpointCandidates({ relay: RELAY, direct: DIRECT })).toEqual([
      { transport: "webSocket", role: "relay", url: `wss://relay.example.com/c/${HOST_ID}` },
      { transport: "webSocket", role: "direct", url: "wss://192.168.1.20:7422/" },
    ]);
    expect(remoteEndpointCandidates({ relay: RELAY })).toEqual([
      { transport: "webSocket", role: "relay", url: `wss://relay.example.com/c/${HOST_ID}` },
    ]);
    expect(remoteEndpointCandidates({ direct: DIRECT })).toEqual([
      { transport: "webSocket", role: "direct", url: "wss://192.168.1.20:7422/" },
    ]);
  });

  it("never publishes loopback addresses", () => {
    expect(remoteEndpointCandidates({ relay: { origin: "http://127.0.0.1:7430", hostId: HOST_ID } })).toEqual([]);
    expect(
      remoteEndpointCandidates({
        relay: { origin: "http://[::1]:7430", hostId: HOST_ID },
        direct: { advertiseUrl: "http://127.0.0.1:7422" },
      }),
    ).toEqual([]);
    // A loopback relay does not shadow a reachable direct candidate.
    expect(
      remoteEndpointCandidates({
        relay: { origin: "http://127.0.0.1:7430", hostId: HOST_ID },
        direct: DIRECT,
      }),
    ).toEqual([{ transport: "webSocket", role: "direct", url: "wss://192.168.1.20:7422/" }]);
  });
});

describe("host endpoint advertisement", () => {
  it("re-probes the LAN address for every invite and hello", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
    const tokenClient = await connectTo(defer, host);
    const port = new URL(host.remote!.url).port;
    const direct = (address: string) => ({
      schemaVersion: 1 as const,
      endpoints: [{ transport: "webSocket" as const, role: "direct" as const, url: `ws://${address}:${port}/` }],
    });

    const firstLink = parsePairingLink((await tokenClient.controller.createPairing()).url)!;
    expect(firstLink.endpointSet).toEqual(direct("192.168.1.20"));

    const device = generateKeyPair();
    const firstHello = await readHello({
      url: host.remote!.url,
      hostKey: host.remote!.hostKey,
      device,
      pairing: { secret: firstLink.secret, name: "phone" },
    });
    expect(firstHello.endpointSet).toEqual(direct("192.168.1.20"));

    // The host keeps running; only the interface address changes.
    lan.address = "192.168.1.21";
    const secondLink = parsePairingLink((await tokenClient.controller.createPairing()).url)!;
    expect(secondLink.endpointSet).toEqual(direct("192.168.1.21"));

    const secondHello = await readHello({
      url: host.remote!.url,
      hostKey: host.remote!.hostKey,
      device,
    });
    expect(secondHello.endpointSet).toEqual(direct("192.168.1.21"));
  });

  it("keeps a loopback relay out of the invite and the secure hello", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      relay: { origin: "http://127.0.0.1:1", reconnectDelayMs: { min: 50, max: 100 } },
    });
    const tokenClient = await connectTo(defer, host);
    const link = parsePairingLink((await tokenClient.controller.createPairing()).url)!;

    expect(new URL(link.url).hostname).toBe("127.0.0.1");
    expect(link.endpointSet).toBeUndefined();

    const hostKey = await loadHostKey(dir.path);
    const hello = await readHello({
      url: `${host.url}/secure`,
      hostKey: hostKey.publicKey,
      device: generateKeyPair(),
      pairing: { secret: link.secret, name: "desktop" },
    });
    expect(hello.endpointSet).toEqual({ schemaVersion: 1, endpoints: [] });
  });

  it("keeps a loopback relay as legacy while publishing a reachable direct candidate", async () => {
    const host = await startFauxHost(defer, {
      remote: { port: 0, publicUrl: "https://pinomad.example.com/base" },
      relay: { origin: "http://127.0.0.1:1", reconnectDelayMs: { min: 50, max: 100 } },
    });
    const tokenClient = await connectTo(defer, host);
    const link = parsePairingLink((await tokenClient.controller.createPairing()).url)!;
    const direct = {
      schemaVersion: 1 as const,
      endpoints: [{ transport: "webSocket" as const, role: "direct" as const, url: "wss://pinomad.example.com/base/" }],
    };

    expect(link.url).toBe("wss://pinomad.example.com/base/");
    expect(link.endpointSet).toEqual(direct);

    const hello = await readHello({
      url: host.remote!.url,
      hostKey: host.remote!.hostKey,
      device: generateKeyPair(),
      pairing: { secret: link.secret, name: "phone" },
    });
    expect(hello.endpointSet).toEqual(direct);
  });

  it.each(["pinomad.example.com", "ftp://pinomad.example.com", "http://"])(
    "rejects an invalid --public-url %s before listening",
    async (publicUrl) => {
      await expect(startFauxHost(defer, { remote: { port: 0, publicUrl } })).rejects.toThrow(/--public-url/);
    },
  );

  it("accepts a direct endpoint at the shared 1024-unit limit", async () => {
    const host = await startFauxHost(defer, {
      remote: { port: 0, publicUrl: `https://example.com/${"a".repeat(1005)}` },
    });
    const tokenClient = await connectTo(defer, host);
    const link = parsePairingLink((await tokenClient.controller.createPairing()).url)!;
    const direct = link.endpointSet!.endpoints[0]!;
    expect(direct.url).toHaveLength(1024);
  });

  it("rejects a direct endpoint above 1024 UTF-16 units before listening", async () => {
    await expect(
      startFauxHost(defer, { remote: { port: 0, publicUrl: `https://example.com/${"a".repeat(1006)}` } }),
    ).rejects.toThrow(/--public-url.*1024/);
  });

  it("accepts a relay target at 1024 UTF-16 units and rejects 1025", () => {
    const keys = ed25519.keygen();
    const base = `${relayWsBase("https://relay.example.com")}/c/${toBase64Url(keys.publicKey)}`;
    // Adding a path to the origin adds one slash plus the padding.
    const pad = 1024 - base.length - 1;
    expect(() => validateRelayTarget(`https://relay.example.com/${"a".repeat(pad)}`, keys.publicKey)).not.toThrow();
    expect(() =>
      validateRelayTarget(`https://relay.example.com/${"a".repeat(pad + 1)}`, keys.publicKey),
    ).toThrow(/1024/);
  });

  it("rejects a relay endpoint above 1024 UTF-16 units before dialing", async () => {
    await expect(
      startFauxHost(defer, {
        relay: { origin: `https://relay.example.com/${"a".repeat(1100)}` },
      }),
    ).rejects.toThrow(/--relay.*1024/);
  });

  it("prints a copyable link when a valid invite exceeds QR capacity", async () => {
    const host = await startFauxHost(defer, {
      remote: { port: 0, publicUrl: `https://example.com/${"a".repeat(1000)}` },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      await printPairing({ url: host.url, token: host.token });
      output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
    expect(output).toContain("This link is too long for a QR code.");
    expect(output).toContain("#pair=");
  });

  it("publishes an explicit empty remote set on a loopback-only secure hello", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, { dataDir: dir.path });
    const tokenClient = await connectTo(defer, host);
    const link = parsePairingLink((await tokenClient.controller.createPairing()).url)!;
    const hostKey = await loadHostKey(dir.path);

    expect(link.endpointSet).toBeUndefined();
    const hello = await readHello({
      url: `${host.url}/secure`,
      hostKey: hostKey.publicKey,
      device: generateKeyPair(),
      pairing: { secret: link.secret, name: "desktop" },
    });
    // The empty set is deliberate: it clears stale remote candidates without
    // ever publishing the loopback address itself.
    expect(hello.endpointSet).toEqual({ schemaVersion: 1, endpoints: [] });
  });
});
