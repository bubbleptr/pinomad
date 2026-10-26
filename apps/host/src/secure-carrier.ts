// A record carrier is the smallest thing the Noise gate needs: binary
// messages in order, one record per message, and a close. WebSockets and
// DataChannels both satisfy it; the gate and the record layer above it stay
// carrier-agnostic (ADR-0033 §2).
import { WebSocket, type RawData } from "ws";

export interface CarrierHandlers {
  /** One binary record from the peer. */
  binary(bytes: Uint8Array): void;
  /** A text frame; the secure channel never carries text at this layer. */
  text(): void;
  closed(): void;
}

export interface RecordCarrier {
  /** True while the carrier can still attempt to send. */
  readonly open: boolean;
  /** Hands one record to the transport; resolves once the transport owns it. */
  send(bytes: Uint8Array): Promise<void>;
  close(code: number, reason: string): void;
  /** Wire inbound events; called once by the handshake. */
  handle(handlers: CarrierHandlers): void;
}

/** A WebSocket carrier: one binary frame is one record. */
export function webSocketCarrier(socket: WebSocket): RecordCarrier {
  // ws emits "error" for malformed frames before Noise ever runs; an
  // unhandled error event would take the whole host down (dureview P1). The
  // loopback listener installs its own handler too; terminating twice is safe.
  socket.on("error", () => socket.terminate());
  return {
    get open() {
      return socket.readyState === WebSocket.OPEN;
    },
    send: (bytes) =>
      socket.readyState === WebSocket.OPEN
        ? new Promise((resolve) => socket.send(bytes, () => resolve()))
        : Promise.resolve(),
    close: (code, reason) => {
      // Calling close() on a CONNECTING socket throws; a handshake that never
      // opened still has to fail closed.
      try {
        socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    },
    handle(handlers) {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          handlers.text();
          return;
        }
        if (Array.isArray(data)) {
          handlers.binary(new Uint8Array(Buffer.concat(data)));
          return;
        }
        handlers.binary(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      });
      socket.once("close", () => handlers.closed());
    },
  };
}
