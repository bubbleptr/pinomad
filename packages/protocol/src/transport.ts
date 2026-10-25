/** One open connection to a host's gateway, carrying serialized frames. */
export interface FrameConnection {
  send(data: string): void;
  close(): void;
}

export interface FrameHandlers {
  message(data: string): void;
  /** Called once, also when the connection never opened; `reason` explains a failure to connect. */
  closed(code: number, reason?: string): void;
  /**
   * The carrier accepted the connection (the WebSocket opened). Optional:
   * simple test carriers may skip it, and the client accepts a frame either way.
   */
  opened?(): void;
  /**
   * The secure handshake completed. A plain carrier reports this with
   * `opened`; a Noise carrier reports it after message 2 verifies. Optional
   * for the same reason as `opened`.
   */
  authenticated?(): void;
}

/** How a client reaches a host: a WebSocket, or another carrier that moves serialized frames. */
export interface FrameTransport {
  /** Shown in errors, for example the host URL. */
  readonly label: string;
  open(handlers: FrameHandlers): FrameConnection;
}

export function webSocketTransport(url: string, token: string): FrameTransport {
  return {
    label: url,
    open(handlers) {
      const address = new URL(url);
      address.searchParams.set("token", token);
      const socket = new WebSocket(address);
      socket.onopen = () => {
        handlers.opened?.();
        handlers.authenticated?.();
      };
      socket.onmessage = (event) => handlers.message(String(event.data));
      socket.onclose = (event) => handlers.closed(event.code);
      return { send: (data) => socket.send(data), close: () => socket.close() };
    },
  };
}
