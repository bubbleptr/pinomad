// A fake APNs over cleartext HTTP/2: node:http2's plaintext server accepts
// prior-knowledge h2c connections, and openApns' `authority` seam points the
// sender at it. Records every request and answers per `responder` — the real
// APNs endpoints are never reachable from tests.
import { createServer, type Http2Server, type Http2Session, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";

export interface ApnsCall {
  /** The device token — the last segment of `:path`. */
  readonly token: string;
  readonly headers: IncomingHttpHeaders;
  readonly payload: unknown;
}

export interface ApnsAnswer {
  readonly status: number;
  /** The JSON error body APNs returns on non-200; omitted → an empty object. */
  readonly body?: unknown;
  /** Extra response headers (e.g. `retry-after`). */
  readonly headers?: Record<string, string>;
  /** Hold the response instead of answering — for in-flight/cap tests. */
  readonly hold?: boolean;
}

export interface FakeApns {
  /** The authority to hand to openApns' per-environment config. */
  readonly authority: string;
  readonly calls: ApnsCall[];
  /** Every server-side session — lets a test goaway or kill the connection. */
  readonly sessions: Http2Session[];
  /** Answer every held stream with `answer`. */
  flushHeld(answer: ApnsAnswer): void;
  waitForCalls(n: number): Promise<void>;
  close(): Promise<void>;
}

export async function fakeApns(responder?: (call: ApnsCall) => ApnsAnswer | Promise<ApnsAnswer>): Promise<FakeApns> {
  const calls: ApnsCall[] = [];
  const held: { stream: import("node:http2").ServerHttp2Stream; call: ApnsCall }[] = [];
  const sessions: Http2Session[] = [];
  const waiters: { n: number; resolve(): void }[] = [];
  const answer = (stream: import("node:http2").ServerHttp2Stream, { status, body, headers }: ApnsAnswer): void => {
    stream.respond({ ":status": status, "content-type": "application/json", ...headers });
    stream.end(JSON.stringify(body ?? {}));
  };
  const server: Http2Server = createServer();
  server.on("session", (session) => {
    sessions.push(session);
    session.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          payload = undefined;
        }
        const call: ApnsCall = { token: String(headers[":path"] ?? "").split("/").pop() ?? "", headers, payload };
        calls.push(call);
        for (const waiter of [...waiters]) {
          if (calls.length >= waiter.n) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        void Promise.resolve(responder?.(call) ?? { status: 200 }).then((result) => {
          if (result.hold) held.push({ stream, call });
          else if (!stream.destroyed) answer(stream, result);
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    authority: `http://127.0.0.1:${port}`,
    calls,
    sessions,
    flushHeld(result) {
      for (const { stream } of held.splice(0)) answer(stream, result);
    },
    waitForCalls(n) {
      return new Promise((resolve) => {
        if (calls.length >= n) resolve();
        else waiters.push({ n, resolve });
      });
    },
    close() {
      for (const session of sessions.splice(0)) session.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
