// Regression for dureview P1: a malformed client frame on the remote secure
// listener is reported by ws as an unhandled "error" before Noise runs. The
// carrier must terminate that socket and leave the host serving.
import { once } from "node:events";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { connectTo, startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();

describe("secure carrier", () => {
  it("terminates an unauthenticated malformed WebSocket frame without taking the host down", async () => {
    const host = await startFauxHost(defer, { remote: { port: 0 } });
    const port = Number(new URL(host.remote!.url).port);
    const socket = connect(port, "127.0.0.1");
    defer(() => socket.destroy());
    await once(socket, "connect");
    socket.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    let response = "";
    while (!response.includes("\r\n\r\n")) {
      const [chunk] = (await once(socket, "data")) as [Buffer];
      response += chunk.toString("latin1");
    }
    expect(response).toContain("101 Switching Protocols");

    // A text frame with no mask bit: ws rejects it as a protocol error.
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await once(socket, "close");

    const client = await connectTo(defer, host);
    expect(client.view.current().connection).toBe("connected");
  });
});
