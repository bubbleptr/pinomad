// Minimal non-trickle-ish signaling relay: an HTTP server for the spike page and
// a WebSocket relay that pairs one host peer with one browser peer. The spike
// only needs a dumb pipe; production signaling is out of scope (#345 PR1).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { parseCandidate } from "../shared/types.ts";

type Role = "host" | "browser";

export type RelayEvent = {
  at: number;
  event: string;
  [key: string]: unknown;
};

export type Relay = {
  port: number;
  events: RelayEvent[];
  waitForBoth(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
};

const sdpCandidateLines = (sdp: string): string[] =>
  sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:"));

const sdpMaxMessageSizeLines = (sdp: string): string[] =>
  sdp.split(/\r?\n/).filter((line) => line.startsWith("a=max-message-size:"));

export async function startRelay(options: {
  token: string;
  pagePath: string;
  bundlePath: string;
}): Promise<Relay> {
  const page = await readFile(options.pagePath, "utf8");
  const bundle = await readFile(options.bundlePath, "utf8");
  const events: RelayEvent[] = [];
  const sockets = new Map<Role, WebSocket>();
  const pending = new Map<Role, string[]>();
  let resolveBoth: (() => void) | undefined;
  let rejectBoth: ((error: Error) => void) | undefined;
  const both = new Promise<void>((resolve, reject) => {
    resolveBoth = resolve;
    rejectBoth = reject;
  });

  const log = (event: string, data: Record<string, unknown> = {}): void => {
    events.push({ at: Date.now(), event, ...data });
  };

  const http: Server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page);
      return;
    }
    if (url.pathname === "/browser.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(bundle);
      return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  const forward = (from: Role, text: string): void => {
    const to: Role = from === "host" ? "browser" : "host";
    const target = sockets.get(to);
    if (target === undefined || target.readyState !== target.OPEN) {
      const queue = pending.get(to) ?? [];
      queue.push(text);
      pending.set(to, queue);
      log("buffered", { from, to, bytes: text.length });
      return;
    }
    target.send(text);
  };

  const handle = (role: Role, socket: WebSocket): void => {
    sockets.set(role, socket);
    log("connected", { role, remote: socket.url ?? "" });
    const queue = pending.get(role) ?? [];
    pending.delete(role);
    for (const text of queue) socket.send(text);
    if (sockets.has("host") && sockets.has("browser")) {
      log("paired", {});
      resolveBoth?.();
    }
    socket.on("message", (data) => {
      const text = data.toString();
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        log("bad-json", { role });
        return;
      }
      const type = String(message.type ?? "");
      if (type === "offer" || type === "answer") {
        const sdp = String(message.sdp ?? "");
        log(`${role}-${type}`, {
          sdpBytes: sdp.length,
          maxMessageSize: sdpMaxMessageSizeLines(sdp),
          candidates: sdpCandidateLines(sdp).map(parseCandidate),
        });
      } else if (type === "candidate") {
        const raw = String(message.candidate ?? "");
        log(`${role}-candidate`, { candidate: parseCandidate(raw), mid: message.mid ?? null });
      } else {
        log(`${role}-${type || "message"}`, {});
      }
      forward(role, text);
    });
    socket.on("close", (code, reason) => {
      log("closed", { role, code, reason: reason.toString() });
      if (sockets.get(role) === socket) sockets.delete(role);
    });
    socket.on("error", (error) => log("socket-error", { role, message: error.message }));
  };

  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.pathname !== "/ws" || url.searchParams.get("token") !== options.token) {
      socket.destroy();
      return;
    }
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "browser") {
      socket.destroy();
      return;
    }
    if (sockets.has(role)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
      handle(role, ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "0.0.0.0", () => resolve());
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("relay has no TCP address");
  const port = address.port;
  log("listening", { port });

  return {
    port,
    events,
    waitForBoth(timeoutMs: number): Promise<void> {
      const timer = setTimeout(() => rejectBoth?.(new Error(`relay did not get both peers within ${timeoutMs}ms`)), timeoutMs);
      return both.finally(() => clearTimeout(timer));
    },
    async close(): Promise<void> {
      for (const socket of sockets.values()) socket.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
