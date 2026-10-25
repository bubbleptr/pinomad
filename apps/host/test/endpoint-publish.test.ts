import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { parsePairingLink } from "@pinomad/protocol/pairing-link.ts";
import { secureWebSocketTransport } from "@pinomad/protocol/secure-channel.ts";
import { loadHostKey } from "../src/devices.ts";
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
