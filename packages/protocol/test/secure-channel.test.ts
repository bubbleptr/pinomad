import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { generateKeyPair, respondIK } from "../src/noise.ts";
import {
  decodeClientHello,
  encodeHostHello,
  secureWebSocketTransport,
  SECURE_PROLOGUE,
  SecureSession,
  type ClientHello,
} from "../src/secure-channel.ts";
import type { FrameConnection, FrameHandlers } from "../src/transport.ts";

interface TestServer {
  readonly url: string;
  readonly hellos: ClientHello[];
  readonly received: string[];
  /** Resolves when the server side sees a connected socket close. */
  nextClose(): Promise<void>;
  /** Close every connected socket with this code. */
  closeAll(code: number): void;
  close(): void;
}

/** An in-test responder that echoes every complete frame back prefixed with "echo:". */
async function startServer(hostPair: ReturnType<typeof generateKeyPair>, options?: { readonly garbage?: boolean }): Promise<TestServer> {
  const hellos: ClientHello[] = [];
  const received: string[] = [];
  const closeWaiters: (() => void)[] = [];
  const sockets = new Set<import("ws").WebSocket>();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      closeWaiters.splice(0).forEach((resolve) => resolve());
    });
    const responder = respondIK({ prologue: SECURE_PROLOGUE, static: hostPair });
    let session: SecureSession | undefined;
    socket.on("message", (data: Buffer) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (session === undefined) {
        if (options?.garbage === true) {
          socket.send(new Uint8Array([9, 9, 9, 9]));
          return;
        }
        try {
          const { payload } = responder.readMessage1(bytes);
          hellos.push(decodeClientHello(payload));
          const { message, result } = responder.writeMessage2(encodeHostHello({ v: 1 }));
          session = new SecureSession(result);
          socket.send(message);
        } catch {
          socket.close(1008, "bad handshake");
        }
        return;
      }
      try {
        const text = session.open(bytes);
        if (text !== undefined) {
          received.push(text);
          for (const chunk of session.seal(`echo:${text}`)) socket.send(chunk);
        }
      } catch {
        socket.close(1008, "bad record");
      }
    });
  });
  return {
    get url() {
      const address = wss.address();
      if (typeof address === "string" || address === null) throw new Error("no address");
      return `ws://127.0.0.1:${address.port}`;
    },
    hellos,
    received,
    closeAll(code: number) {
      for (const socket of sockets) socket.close(code);
    },
    nextClose(): Promise<void> {
      return new Promise((resolve) => closeWaiters.push(resolve));
    },
    close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
    },
  };
}

interface Probe {
  readonly messages: string[];
  readonly closed: Promise<{ code: number; reason?: string }>;
  readonly connection: FrameConnection;
  /** Resolves on the first message (after the handshake is done and a frame arrives). */
  nextMessage(): Promise<string>;
}

function openClient(
  transport: ReturnType<typeof secureWebSocketTransport>,
): Probe {
  const messages: string[] = [];
  const waiting: ((text: string) => void)[] = [];
  let closedResolve!: (close: { code: number; reason?: string }) => void;
  const closed = new Promise<{ code: number; reason?: string }>((resolve) => (closedResolve = resolve));
  const handlers: FrameHandlers = {
    message(text) {
      const pending = waiting.shift();
      if (pending !== undefined) pending(text);
      else messages.push(text);
    },
    closed: (code, reason) => closedResolve({ code, reason }),
  };
  const connection = transport.open(handlers);
  return {
    messages,
    closed,
    connection,
    nextMessage: () =>
      messages.length > 0 ? Promise.resolve(messages.shift()!) : new Promise((resolve) => waiting.push(resolve)),
  };
}

describe("secureWebSocketTransport", () => {
  it("sends the pairing payload only on the first connection and calls onPaired once", async () => {
    const host = generateKeyPair();
    const server = await startServer(host);
    let paired = 0;
    const transport = secureWebSocketTransport({
      url: server.url,
      hostKey: host.publicKey,
      device: generateKeyPair(),
      pairing: { secret: "one-time", name: "phone" },
      onPaired: () => paired++,
    });

    const first = openClient(transport);
    first.connection.send("hi");
    expect(await first.nextMessage()).toBe("echo:hi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.hellos).toHaveLength(1);
    expect(server.hellos[0]!.pair).toEqual({ secret: "one-time", name: "phone" });
    expect(paired).toBe(1);

    server.closeAll(1000);
    await first.closed;

    const second = openClient(transport);
    second.connection.send("again");
    expect(await second.nextMessage()).toBe("echo:again");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.hellos).toHaveLength(2);
    expect(server.hellos[1]!.pair).toBeUndefined();
    expect(paired).toBe(1);
    server.close();
  });

  it("round-trips frames both ways, including one larger than a Noise record", async () => {
    const host = generateKeyPair();
    const server = await startServer(host);
    const transport = secureWebSocketTransport({ url: server.url, hostKey: host.publicKey, device: generateKeyPair() });
    const client = openClient(transport);

    client.connection.send("small");
    expect(await client.nextMessage()).toBe("echo:small");

    const big = "b".repeat(70 * 1024) + "末";
    client.connection.send(big);
    expect(await client.nextMessage()).toBe(`echo:${big}`);
    expect(server.received).toEqual(["small", big]);
    server.close();
  });

  it("passes a server close code through exactly once", async () => {
    const host = generateKeyPair();
    const server = await startServer(host);
    const transport = secureWebSocketTransport({ url: server.url, hostKey: host.publicKey, device: generateKeyPair() });
    const client = openClient(transport);
    client.connection.send("hi");
    await client.nextMessage();

    server.closeAll(4401);
    const outcome = await client.closed;
    expect(outcome.code).toBe(4401);
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();
  });

  it("reports closed(1008) when the peer sends garbage instead of message 2", async () => {
    const host = generateKeyPair();
    const server = await startServer(host, { garbage: true });
    const transport = secureWebSocketTransport({ url: server.url, hostKey: host.publicKey, device: generateKeyPair() });
    const serverClose = server.nextClose();
    const client = openClient(transport);
    const outcome = await client.closed;
    expect(outcome.code).toBe(1008);
    // fail() must actually close the socket, not just report it.
    await serverClose;
    server.close();
  });
});
