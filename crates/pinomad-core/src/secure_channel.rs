// The Noise-secured socket: IK handshake, hello payloads, and the
// flag-prefixed record layer that carries one JSON text frame across
// several encrypted chunks (packages/protocol/src/secure-channel.ts).
//
// Two details are load-bearing:
// - the Noise prologue is the literal UTF-8 bytes of "pinomad/1" —
//   cross-protocol replay protection;
// - a failed record decrypt permanently kills the session, because the
//   JS reference advances its cipher nonce before decrypting. snow only
//   advances on success, so the dead flag below replicates the poisoning
//   a failed decrypt does there: tampering, replay, and reorder all wedge
//   the receive direction identically.

use std::sync::{Arc, Mutex};

use crate::b64::{from_base64url, to_base64url};
use crate::json::{Json, JsonObject};
use crate::noise::{
    generate_keypair, initiate_ik, respond_ik, IkInitiator, IkResponder, KeyPair, InitiateOptions,
    RespondOptions, KEY_LENGTH, MAX_MESSAGE,
};
use crate::transport::{ConnOut, Connection, Transport};
use crate::u16str::U16String;
use snow::TransportState;

/// Noise prologue — the literal protocol name, protecting the channel from
/// cross-protocol replay (secure-channel.ts SECURE_PROLOGUE).
pub const SECURE_PROLOGUE: &[u8] = b"pinomad/1";

/// The prologue of a signal-only connection (ADR-0033 §1). A host that only
/// knows `pinomad/1` fails this handshake before it registers anything.
pub const SIGNAL_PROLOGUE: &[u8] = b"pinomad-signal/1";

/// One byte of flags per record; a ciphertext is one flag byte plus a Noise
/// message under the 65535 bound.
const MAX_CIPHERTEXT: usize = MAX_MESSAGE;
const MAX_BODY: usize = MAX_CIPHERTEXT - 1;
const MAX_PLAINTEXT: usize = MAX_BODY - 16;

/// What the device sends in the IK payload (ClientHello): the pairing
/// secret and name only travel on the FIRST connection — after a pairing
/// completes they are gone, so a reconnect cannot double-consume an offer.
#[derive(Clone)]
pub struct Pairing {
    pub secret: String,
    pub name: String,
}

/// The host hello — `{v:1}` is the whole contract; unknown fields ride
/// along in `raw` untouched.
#[derive(Clone, Debug)]
pub struct HostHello {
    pub version: i64,
    pub raw: Json,
}

#[derive(Debug)]
pub enum ChannelError {
    Noise(String),
    /// Malformed hello/record data — the frame decode fails before any key
    /// material is trusted.
    Hello(String),
}

impl std::fmt::Display for ChannelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChannelError::Noise(m) | ChannelError::Hello(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ChannelError {}

fn fail(message: &str) -> ChannelError {
    ChannelError::Hello(message.to_string())
}

/// `encodeClientHello` — `{v:1}` plus an optional `pair` block.
pub fn encode_client_hello(pairing: Option<&Pairing>) -> String {
    let mut object = JsonObject::new();
    object.set(U16String::from_str("v"), Json::Number(1.0));
    if let Some(pairing) = pairing {
        let mut pair = JsonObject::new();
        pair.set(U16String::from_str("secret"), Json::from(pairing.secret.clone()));
        pair.set(U16String::from_str("name"), Json::from(pairing.name.clone()));
        object.set(U16String::from_str("pair"), Json::Object(Arc::new(pair)));
    }
    Json::Object(Arc::new(object)).to_json()
}

/// `decodeHostHello` — `v !== 1` rejects, everything else rides along.
pub fn decode_host_hello(text: &str) -> Result<HostHello, ChannelError> {
    let hello = Json::parse(text).map_err(|_| fail("handshake payload is not JSON"))?;
    let version = hello
        .get("v")
        .and_then(Json::as_number)
        .filter(|v| *v == 1.0)
        .ok_or_else(|| fail("unsupported host hello"))?;
    Ok(HostHello { version: version as i64, raw: hello })
}

/// `decodeClientHello` — for the responder side (tests): `pair` requires
/// both `secret` and `name` as strings, or the whole hello is malformed.
pub fn decode_client_hello(text: &str) -> Result<(i64, Option<Pairing>), ChannelError> {
    let hello = Json::parse(text).map_err(|_| fail("handshake payload is not JSON"))?;
    let version = hello
        .get("v")
        .and_then(Json::as_number)
        .filter(|v| *v == 1.0)
        .ok_or_else(|| fail("unsupported client hello"))?;
    let pairing = hello
        .get("pair")
        .map(|pair| {
            let secret = pair.get("secret").and_then(Json::as_str).map(|s| s.to_string_lossy());
            let name = pair.get("name").and_then(Json::as_str).map(|s| s.to_string_lossy());
            match (secret, name) {
                (Some(secret), Some(name)) => Ok(Pairing { secret, name }),
                _ => Err(fail("malformed pair")),
            }
        })
        .transpose()?;
    Ok((version as i64, pairing))
}

// ─── Record layer ────────────────────────────────────────────────────────────

/// A sealed Noise channel: ciphertext in, plaintext out — with the session
/// poisoned permanently on the first authentication failure.
struct CipherPair {
    transport: TransportState,
    /// Any failed `open` wedges the receiving direction for the life of the
    /// channel — the JS cipher's nonce stays advanced past the bad record,
    /// so every later record also fails. Both sides of the shared channel
    /// (a session and its `fork`s) inherit the wedge.
    receive_dead: bool,
}

/// One end of a secure channel. Records arriving before the previous text
/// completes are buffered so `seal` calls interleave correctly — same as
/// the reference's `pending` list.
pub struct SecureSession {
    pair: Arc<Mutex<CipherPair>>,
    pending: Vec<Vec<u8>>,
}

impl SecureSession {
    pub fn new(transport: TransportState) -> Self {
        SecureSession {
            pair: Arc::new(Mutex::new(CipherPair { transport, receive_dead: false })),
            pending: Vec::new(),
        }
    }

    /// Another session over the same ciphers (the tests drive both halves
    /// of a channel through two sessions).
    pub fn fork(&self) -> Self {
        SecureSession { pair: self.pair.clone(), pending: Vec::new() }
    }

    /// `session.seal(text)`: UTF-8 body split under the record bound,
    /// `flag 1` continuations then a final `flag 0`.
    pub fn seal(&mut self, text: &str) -> Result<Vec<Vec<u8>>, ChannelError> {
        let bytes = text.as_bytes();
        let chunks = bytes.len().div_ceil(MAX_PLAINTEXT);
        let mut records = Vec::with_capacity(chunks.max(1));
        let mut pair = self.pair.lock().expect("cipher pair poisoned");
        for index in 0..chunks.max(1) {
            let start = index * MAX_PLAINTEXT;
            let end = (start + MAX_PLAINTEXT).min(bytes.len());
            let last = end == bytes.len();
            // The continuation flag rides inside the AEAD plaintext.
            let mut plaintext = Vec::with_capacity(end - start + 1);
            plaintext.push(if last { 0 } else { 1 });
            plaintext.extend_from_slice(&bytes[start..end]);
            let mut record = vec![0u8; plaintext.len() + 16];
            let len = pair
                .transport
                .write_message(&plaintext, &mut record)
                .map_err(|error| ChannelError::Noise(error.to_string()))?;
            record.truncate(len);
            records.push(record);
        }
        Ok(records)
    }

    /// `session.open(chunk)`: decrypt one record; `Some(text)` when a text
    /// frame completes. Any failure kills the session receive direction.
    pub fn open(&mut self, chunk: &[u8]) -> Result<Option<String>, ChannelError> {
        // One lock for the check-and-decrypt: with forks shareable across
        // threads, a poison set between two lock()s would let one record
        // through that the wedge semantics forbid.
        let mut pair = self.pair.lock().expect("cipher pair poisoned");
        if pair.receive_dead {
            return Err(ChannelError::Noise("session is poisoned".into()));
        }
        let mut plaintext = vec![0u8; chunk.len()];
        match pair.transport.read_message(chunk, &mut plaintext) {
            Err(error) => {
                pair.receive_dead = true;
                Err(ChannelError::Noise(error.to_string()))
            }
            Ok(len) => {
                plaintext.truncate(len);
                // The flag byte must be 0 or 1 — an empty plaintext or any
                // other flag fails like "bad record flag" and poisons.
                match plaintext.first() {
                    Some(0) | Some(1) => {}
                    _ => {
                        pair.receive_dead = true;
                        return Err(ChannelError::Noise("bad record flag".into()));
                    }
                }
                let finished = plaintext[0] == 0;
                let mut pending = std::mem::take(&mut self.pending);
                pending.push(plaintext[1..].to_vec());
                if !finished {
                    self.pending = pending;
                    return Ok(None);
                }
                let body: Vec<u8> = pending.concat();
                match String::from_utf8(body) {
                    Ok(text) => Ok(Some(text)),
                    Err(_) => {
                        // fatal decoding, like TextDecoder(fatal:true): bad
                        // UTF-8 across records is a channel failure.
                        pair.receive_dead = true;
                        Err(ChannelError::Noise("invalid utf8 in secure record".into()))
                    }
                }
            }
        }
    }
}

// ─── Handshake + connection ──────────────────────────────────────────────────

/// The two-message IK exchange, initiator side (the device).
pub struct IkClientHandshake {
    inner: IkInitiator,
    /// Device public key — what the host records for the device.
    pub device_public_key: [u8; KEY_LENGTH],
    /// The host static key the channel authenticates to.
    pub remote_static: [u8; KEY_LENGTH],
    /// The client hello sent inside message 1.
    pub hello_text: String,
}

impl IkClientHandshake {
    pub fn message1(&self) -> &[u8] {
        &self.inner.message1
    }

    /// Process the host's message 2 → (host hello, finished channel).
    pub fn read_message2(self, message: &[u8]) -> Result<(HostHello, SecureSession, [u8; 32]), ChannelError> {
        let (payload, result) = self
            .inner
            .read_message2(message)
            .map_err(|error| ChannelError::Noise(error.to_string()))?;
        let text = String::from_utf8(payload).map_err(|_| fail("host hello is not utf8"))?;
        let hello = decode_host_hello(&text)?;
        Ok((hello, SecureSession::new(result.transport), result.handshake_hash))
    }
}

/// `initiateIK` — begin the IK handshake with the device hello ready.
pub fn initiate_handshake(
    device: &KeyPair,
    remote_static: [u8; KEY_LENGTH],
    pairing: Option<&Pairing>,
) -> Result<IkClientHandshake, ChannelError> {
    initiate_handshake_with_prologue(device, remote_static, pairing, SECURE_PROLOGUE)
}

/// `initiate_handshake` with an explicit prologue; signal-only connections
/// pass `SIGNAL_PROLOGUE` (ADR-0033 §1).
pub fn initiate_handshake_with_prologue(
    device: &KeyPair,
    remote_static: [u8; KEY_LENGTH],
    pairing: Option<&Pairing>,
    prologue: &[u8],
) -> Result<IkClientHandshake, ChannelError> {
    let hello_text = encode_client_hello(pairing);
    let inner = initiate_ik(InitiateOptions {
        prologue,
        device,
        remote_static,
        payload: hello_text.as_bytes(),
        ephemeral: None,
    })
    .map_err(|error| ChannelError::Noise(error.to_string()))?;
    Ok(IkClientHandshake {
        inner,
        device_public_key: device.public_key,
        remote_static,
        hello_text,
    })
}

/// `respondIK`-equivalent for tests: read message 1, answer message 2.
pub struct IkServerHandshake {
    inner: Option<IkResponder>,
    /// The device's static key, recovered from message 1.
    pub remote_static: Option<[u8; KEY_LENGTH]>,
    /// The client hello payload from message 1.
    pub client_payload: Option<Vec<u8>>,
}

pub fn respond_handshake(host: &KeyPair) -> Result<IkServerHandshake, ChannelError> {
    respond_handshake_with_prologue(host, SECURE_PROLOGUE)
}

/// The responder side with an explicit prologue; used by the tests that prove
/// a signal handshake cannot be mistaken for a business one.
pub fn respond_handshake_with_prologue(
    host: &KeyPair,
    prologue: &[u8],
) -> Result<IkServerHandshake, ChannelError> {
    let inner = respond_ik(RespondOptions { prologue, host, ephemeral: None })
        .map_err(|error| ChannelError::Noise(error.to_string()))?;
    Ok(IkServerHandshake { inner: Some(inner), remote_static: None, client_payload: None })
}

impl IkServerHandshake {
    pub fn read_message1(&mut self, message: &[u8]) -> Result<(String, [u8; KEY_LENGTH]), ChannelError> {
        let (payload, remote) = self
            .inner
            .as_mut()
            .ok_or_else(|| fail("handshake already answered"))?
            .read_message1(message)
            .map_err(|error| ChannelError::Noise(error.to_string()))?;
        let text = String::from_utf8(payload.clone()).map_err(|_| fail("client hello is not utf8"))?;
        self.remote_static = Some(remote);
        self.client_payload = Some(payload);
        Ok((text, remote))
    }

    pub fn write_message2(mut self, host_hello: &str) -> Result<(Vec<u8>, SecureSession), ChannelError> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| fail("handshake already answered"))?;
        let (message, result) = inner
            .write_message2(host_hello.as_bytes())
            .map_err(|error| ChannelError::Noise(error.to_string()))?;
        Ok((message, SecureSession::new(result.transport)))
    }
}

/// `encodeHostHello`-equivalent for tests: `{v:1}`.
pub fn encode_host_hello() -> String {
    let mut object = JsonObject::new();
    object.set(U16String::from_str("v"), Json::Number(1.0));
    Json::Object(Arc::new(object)).to_json()
}

// ─── SecureConnection: the RemoteDurable-facing transport ────────────────────

enum Stage {
    /// Socket open, message 1 sent, waiting for message 2.
    Handshaking(IkClientHandshake),
    /// Channel live.
    Ready(SecureSession),
    /// Handshake or record failed; the socket is being closed.
    Dead,
}

/// The shared pairing offer for one connection round. Every candidate
/// builds its own Noise handshake, but message 2 is accepted at most once:
/// the first channel to authenticate takes the secret, and later candidates
/// dial with the device identity alone.
#[derive(Clone, Default)]
pub struct PairingState {
    inner: Arc<Mutex<Option<Pairing>>>,
}

impl PairingState {
    pub fn new(pairing: Option<Pairing>) -> Self {
        PairingState { inner: Arc::new(Mutex::new(pairing)) }
    }

    pub fn current(&self) -> Option<Pairing> {
        self.inner.lock().expect("pairing state poisoned").clone()
    }

    fn take(&self) -> Option<Pairing> {
        self.inner.lock().expect("pairing state poisoned").take()
    }
}

/// The client-side `secureWebSocketTransport`: Noise IK on open, then the
/// record layer carries the gateway frames. Queued texts flush when the
/// session is ready, so frames sent during the handshake are not lost.
pub struct SecureConnection {
    stage: Stage,
    /// Frames queued before the session is established — same contract as
    /// the reference's queue: send() before ready stashes the text.
    queue: Vec<String>,
    /// Whether the client hello carried `pair` — only a channel opened with
    /// the pairing secret may announce it completed.
    sent_pairing: bool,
    /// The reference's `closedFired`: a channel failure already reported a
    /// synthetic 1008; the socket's own close must not report twice.
    closed_fired: bool,
}

impl SecureConnection {
    pub fn new(device: &KeyPair, remote_static: [u8; KEY_LENGTH], pairing: Option<&Pairing>) -> Result<Self, ChannelError> {
        Self::new_with_prologue(device, remote_static, pairing, SECURE_PROLOGUE)
    }

    /// A connection whose handshake uses `prologue`; the signal channel is the
    /// reason this is parameterized (ADR-0033 §1).
    pub fn new_with_prologue(
        device: &KeyPair,
        remote_static: [u8; KEY_LENGTH],
        pairing: Option<&Pairing>,
        prologue: &[u8],
    ) -> Result<Self, ChannelError> {
        let handshake = initiate_handshake_with_prologue(device, remote_static, pairing, prologue)?;
        Ok(SecureConnection {
            stage: Stage::Handshaking(handshake),
            queue: Vec::new(),
            sent_pairing: pairing.is_some(),
            closed_fired: false,
        })
    }

    /// Whether the channel is live (used by the pairing-completion check).
    pub fn established(&self) -> bool {
        matches!(self.stage, Stage::Ready(_))
    }

    fn drop(&mut self, error: &ChannelError, out: &mut Vec<ConnOut>) {
        self.stage = Stage::Dead;
        out.push(ConnOut::Close);
        if !self.closed_fired {
            self.closed_fired = true;
            out.push(ConnOut::Closed { code: 1008, reason: Some(format!("Secure channel failed: {error}")) });
        }
    }
}

impl Connection for SecureConnection {
    fn opened(&mut self, out: &mut Vec<ConnOut>) {
        if let Stage::Handshaking(handshake) = &self.stage {
            out.push(ConnOut::SendBytes(handshake.message1().to_vec()));
        }
    }

    fn data(&mut self, bytes: &[u8], out: &mut Vec<ConnOut>) {
        if matches!(self.stage, Stage::Handshaking(_)) {
            // read_message2 consumes the handshake — take the stage first.
            let stage = std::mem::replace(&mut self.stage, Stage::Dead);
            let Stage::Handshaking(handshake) = stage else { unreachable!() };
            match handshake.read_message2(bytes) {
                Ok((_hello, session, _hash)) => {
                    self.stage = Stage::Ready(session);
                    let paired = self.sent_pairing;
                    self.sent_pairing = false;
                    out.push(ConnOut::Authenticated { paired });
                    let queued = std::mem::take(&mut self.queue);
                    for text in queued {
                        self.send(text, out);
                    }
                }
                Err(error) => self.drop(&error, out),
            }
            return;
        }
        match &mut self.stage {
            Stage::Ready(session) => match session.open(bytes) {
                Ok(Some(text)) => out.push(ConnOut::Text(text)),
                Ok(None) => {}
                Err(error) => self.drop(&error, out),
            },
            _ => {}
        }
    }

    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>) {
        if !self.closed_fired {
            self.closed_fired = true;
            out.push(ConnOut::Closed { code, reason });
        }
    }

    fn send(&mut self, text: String, out: &mut Vec<ConnOut>) {
        match &mut self.stage {
            Stage::Handshaking(_) => self.queue.push(text),
            Stage::Ready(session) => match session.seal(&text) {
                Ok(records) => {
                    for record in records {
                        out.push(ConnOut::SendBytes(record));
                    }
                }
                Err(error) => self.drop(&error, out),
            },
            Stage::Dead => {}
        }
    }

    fn close(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
    }
}

/// `secureWebSocketTransport` — makes one SecureConnection per generation.
/// `device_private_key` is base64url to match StoredHost's shape; the
/// pairing secret is consumed by `mark_paired` the first time a channel
/// completes.
pub struct SecureTransport {
    url: String,
    host_key: [u8; KEY_LENGTH],
    host_key_b64: String,
    device: KeyPair,
    device_private_b64: String,
    pairing: PairingState,
}

impl SecureTransport {
    pub fn new(url: &str, host_key: &str, device_private_key: &str, pairing: Option<Pairing>) -> Result<Self, ChannelError> {
        Self::with_pairing_state(url, host_key, device_private_key, PairingState::new(pairing))
    }

    /// A candidate connection in a round that may try several sockets: all of
    /// them share the same device key and one-time pairing state.
    pub fn with_pairing_state(
        url: &str,
        host_key: &str,
        device_private_key: &str,
        pairing: PairingState,
    ) -> Result<Self, ChannelError> {
        let host_key_bytes: [u8; KEY_LENGTH] = from_base64url(host_key)
            .map_err(|_| fail("hostKey is not base64url"))?
            .try_into()
            .map_err(|_| fail("hostKey must decode to 32 bytes"))?;
        let device = crate::noise::keypair_from_private(
            &from_base64url(device_private_key).map_err(|_| fail("privateKey is not base64url"))?,
        )
        .map_err(|error| ChannelError::Noise(error.to_string()))?;
        Ok(SecureTransport {
            url: url.to_string(),
            host_key: host_key_bytes,
            host_key_b64: host_key.to_string(),
            device,
            device_private_b64: device_private_key.to_string(),
            pairing,
        })
    }

    /// A fresh device identity for an unpaired connection — the app stores
    /// the base64url of `private_key` once the pairing answers.
    pub fn new_device() -> Result<(KeyPair, String), ChannelError> {
        let pair = generate_keypair().map_err(|error| ChannelError::Noise(error.to_string()))?;
        Ok((pair.clone(), to_base64url(&pair.private_key)))
    }

    pub fn pairing(&self) -> Option<Pairing> {
        self.pairing.current()
    }
}

impl Transport for SecureTransport {
    fn url(&self) -> &str {
        &self.url
    }

    fn open(&mut self) -> Box<dyn Connection> {
        let pairing = self.pairing.current();
        match SecureConnection::new(&self.device, self.host_key, pairing.as_ref()) {
            Ok(connection) => Box::new(connection),
            Err(_) => Box::new(DeadConnection),
        }
    }

    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        // Only the generation that actually carried the invite may spend it.
        self.pairing.take()?;
        Some((
            self.url.clone(),
            self.host_key_b64.clone(),
            self.device_private_b64.clone(),
        ))
    }
}

/// A candidate whose key material could not even build a carrier. It still
/// needs to close cleanly and report why, rather than pretend bytes can flow.
pub struct UnavailableTransport {
    pub url: String,
    pub reason: String,
}

impl Transport for UnavailableTransport {
    fn url(&self) -> &str {
        &self.url
    }

    fn open(&mut self) -> Box<dyn Connection> {
        Box::new(UnavailableConnection { reason: self.reason.clone() })
    }
}

struct UnavailableConnection {
    reason: String,
}

impl Connection for UnavailableConnection {
    fn opened(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
        out.push(ConnOut::Closed {
            code: 1008,
            reason: Some(format!("Secure channel failed: {}", self.reason)),
        });
    }
    fn data(&mut self, _bytes: &[u8], _out: &mut Vec<ConnOut>) {}
    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Closed { code, reason });
    }
    fn send(&mut self, _text: String, _out: &mut Vec<ConnOut>) {}
    fn close(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
    }
}

/// A transport whose handshake could not even be constructed; it still
/// needs to close cleanly rather than pretend bytes can flow — like
/// `fail()`: the platform closes the socket, then the close surfaces.
struct DeadConnection;

impl Connection for DeadConnection {
    fn opened(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
        out.push(ConnOut::Closed { code: 1008, reason: Some("Secure channel failed: setup".into()) });
    }
    fn data(&mut self, _bytes: &[u8], _out: &mut Vec<ConnOut>) {}
    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Closed { code, reason });
    }
    fn send(&mut self, _text: String, _out: &mut Vec<ConnOut>) {}
    fn close(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
    }
}
