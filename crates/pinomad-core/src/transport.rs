// The seam RemoteDurable drives a socket through, mirroring FrameTransport
// from packages/protocol/src/transport.ts: the state machine emits socket
// actions, socket events come back in. Each `open` is a fresh connection
// generation — the state machine numbers them so events from a dead
// generation cannot reach a live one.
//
// The platform layer (or a test harness) owns the real socket; the core
// only asks for bytes to be written or the socket closed. Everything a
// connection needs to say back to RemoteDurable is a ConnOut — frames
// arriving as text, the socket closing, a completed pairing.

/// What a connection tells its owner: socket actions, text frames, its own
/// death, or the first successful pairing.
#[derive(Debug)]
pub enum ConnOut {
    /// Write these bytes to the socket (a Noise handshake or a record).
    SendBytes(Vec<u8>),
    /// Close the socket (handshake/record failure, or a request to close).
    Close,
    /// A complete JSON text frame for the gateway protocol.
    Text(String),
    /// The socket is gone — the reference's `closed` handler.
    Closed { code: u16, reason: Option<String> },
    /// Noise message 2 verified (ADR-0024 §2, ADR-0032): the channel is
    /// authenticated. `paired` is true only when this generation carried the
    /// one-time pairing secret; the owner then persists the device identity
    /// and the shared pairing state forgets the secret.
    Authenticated { paired: bool },
}

/// One generation of a socket-level connection. Implementations handle the
/// protocol on top of raw bytes — Noise + records for `SecureConnection`,
/// plain JSON for tests' `PlaintextConnection`.
///
/// `Send` because the whole state machine crosses threads at the FFI
/// boundary (the UniFFI facade owns it behind a mutex).
pub trait Connection: Send {
    /// The socket is writable: send whatever the protocol needs first
    /// (the IK message 1 for the secure channel, nothing for plaintext).
    fn opened(&mut self, out: &mut Vec<ConnOut>);
    /// Raw inbound bytes arrived.
    fn data(&mut self, bytes: &[u8], out: &mut Vec<ConnOut>);
    /// The socket ended — pass the close code through like `closed` does.
    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>);
    /// A JSON text frame to send. May be queued until the channel is ready.
    fn send(&mut self, text: String, out: &mut Vec<ConnOut>);
    /// Asked to close the socket.
    fn close(&mut self, out: &mut Vec<ConnOut>);
}

/// Makes new connections; each `open` is one generation (the reference
/// closes over per-open state the same way). `Send` for the same reason as
/// `Connection`.
pub trait Transport: Send {
    /// The URL the state machine reports in errors and pairing commands.
    fn url(&self) -> &str;
    /// A short name for error messages, like `transport.label`.
    fn label(&self) -> String {
        self.url().to_string()
    }
    /// Build the next connection generation.
    fn open(&mut self) -> Box<dyn Connection>;
    /// A pairing just completed (ConnOut::Authenticated { paired: true }):
    /// forget the secret and report `(url, host_key, private_key)` for the
    /// app to persist. Implementations that never pair return None.
    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        None
    }
}

/// Plaintext JSON over the socket — the test carrier, equivalent to what
/// the TS suite's fake transports speak. Never used by the real apps,
/// which always take the Noise channel.
pub struct PlaintextTransport {
    pub url: String,
}

impl Transport for PlaintextTransport {
    fn url(&self) -> &str {
        &self.url
    }
    fn open(&mut self) -> Box<dyn Connection> {
        Box::new(PlaintextConnection)
    }
}

pub struct PlaintextConnection;

impl Connection for PlaintextConnection {
    fn opened(&mut self, _out: &mut Vec<ConnOut>) {}
    fn data(&mut self, bytes: &[u8], out: &mut Vec<ConnOut>) {
        // One socket message is one frame; malformed UTF-8 is a protocol
        // failure the peer should never produce — the state machine drops
        // the connection on the close that follows a real socket failure.
        match String::from_utf8(bytes.to_vec()) {
            Ok(text) => out.push(ConnOut::Text(text)),
            Err(_) => out.push(ConnOut::Closed {
                code: 1006,
                reason: None,
            }),
        }
    }
    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Closed { code, reason });
    }
    fn send(&mut self, text: String, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::SendBytes(text.into_bytes()));
    }
    fn close(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
    }
}
