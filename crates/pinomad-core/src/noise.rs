// Noise_IK_25519_ChaChaPoly_BLAKE2s via the `snow` crate — no crypto is
// implemented here (ADR-0024 §2). Only IK: the initiator knows the
// responder's static key up front, so both sides authenticate in two
// messages. The Cacophony vectors in packages/protocol/test/fixtures pin
// the wire bytes against an independent implementation.

use snow::resolvers::CryptoResolver;
use snow::{Builder, HandshakeState, TransportState};

pub const NOISE_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
pub const KEY_LENGTH: usize = 32;
/// Noise's message bound; the record layer stays under it.
pub const MAX_MESSAGE: usize = 65535;

#[derive(Debug)]
pub struct NoiseError(pub String);

impl std::fmt::Display for NoiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NoiseError {}

impl From<snow::Error> for NoiseError {
    fn from(error: snow::Error) -> Self {
        NoiseError(error.to_string())
    }
}

#[derive(Clone)]
pub struct KeyPair {
    pub public_key: [u8; KEY_LENGTH],
    pub private_key: [u8; KEY_LENGTH],
}

pub fn generate_keypair() -> Result<KeyPair, NoiseError> {
    let params: snow::params::NoiseParams = NOISE_PATTERN.parse().expect("static pattern");
    let pair = Builder::new(params).generate_keypair()?;
    Ok(KeyPair {
        public_key: pair.public.try_into().expect("x25519 public is 32 bytes"),
        private_key: pair.private.try_into().expect("x25519 private is 32 bytes"),
    })
}

pub fn keypair_from_private(private_key: &[u8]) -> Result<KeyPair, NoiseError> {
    let private: [u8; KEY_LENGTH] = private_key
        .try_into()
        .map_err(|_| NoiseError(format!("X25519 private key must be {KEY_LENGTH} bytes")))?;
    // X25519 base-point multiply through the resolver's Dh impl — the same
    // primitive the handshake uses.
    let params: snow::params::NoiseParams = NOISE_PATTERN.parse().expect("static pattern");
    let mut dh = snow::resolvers::DefaultResolver
        .resolve_dh(&params.dh)
        .ok_or_else(|| NoiseError("no DH resolver".into()))?;
    dh.set(&private);
    let public: [u8; KEY_LENGTH] = dh.pubkey().try_into().expect("x25519 public is 32 bytes");
    Ok(KeyPair { public_key: public, private_key: private })
}

/// A finished handshake: the transport channel plus the hash that binds it.
pub struct HandshakeResult {
    pub transport: TransportState,
    pub handshake_hash: [u8; 32],
}

/// The initiator side of IK (the device). `ephemeral` exists for the
//  Cacophony test vectors; production leaves it out and snow draws a fresh
//  ephemeral every handshake.
pub fn initiate_ik(options: InitiateOptions<'_>) -> Result<IkInitiator, NoiseError> {
    let params: snow::params::NoiseParams = NOISE_PATTERN.parse().expect("static pattern");
    let mut builder = Builder::new(params)
        .local_private_key(&options.device.private_key)
        .map_err(NoiseError::from)?
        .remote_public_key(&options.remote_static)
        .map_err(NoiseError::from)?
        .prologue(options.prologue)
        .map_err(NoiseError::from)?;
    if let Some(ephemeral) = options.ephemeral {
        builder = builder.fixed_ephemeral_key_for_testing_only(&ephemeral.private_key);
    }
    let mut state = builder.build_initiator().map_err(NoiseError::from)?;
    // Write message 1 lazily the first time the caller asks — the pattern
    // fixes what it contains, but producing it up front would force every
    // constructor to allocate the 64KiB output buffer.
    let mut buffer = vec![0u8; MAX_MESSAGE];
    let len = state
        .write_message(options.payload, &mut buffer)
        .map_err(NoiseError::from)?;
    buffer.truncate(len);
    Ok(IkInitiator { state, message1: buffer })
}

pub struct InitiateOptions<'a> {
    pub prologue: &'a [u8],
    pub device: &'a KeyPair,
    pub remote_static: [u8; KEY_LENGTH],
    /// Client → host handshake payload (the client hello), already encoded.
    pub payload: &'a [u8],
    /// Vectors only; a fresh ephemeral is drawn when absent.
    pub ephemeral: Option<&'a KeyPair>,
}

pub struct IkInitiator {
    state: HandshakeState,
    /// The completed IK message 1 (`-> e, es, s, ss` + payload), sent once
    /// the socket is open.
    pub message1: Vec<u8>,
}

impl IkInitiator {
    /// Feed the responder's message 2; on success the channel is live and
    /// this handshake is spent.
    pub fn read_message2(mut self, message: &[u8]) -> Result<(Vec<u8>, HandshakeResult), NoiseError> {
        if message.len() > MAX_MESSAGE {
            return Err(NoiseError(format!("handshake message exceeds {MAX_MESSAGE} bytes")));
        }
        let mut payload = vec![0u8; MAX_MESSAGE];
        let len = self.state.read_message(message, &mut payload).map_err(NoiseError::from)?;
        payload.truncate(len);
        let handshake_hash: [u8; 32] = self
            .state
            .get_handshake_hash()
            .try_into()
            .expect("blake2s handshake hash is 32 bytes");
        let transport = self
            .state
            .into_transport_mode()
            .map_err(NoiseError::from)?;
        Ok((payload, HandshakeResult { transport, handshake_hash }))
    }
}

/// The responder side of IK — the client's peer in tests only; the real
/// responder is always the TS host.
pub fn respond_ik(options: RespondOptions<'_>) -> Result<IkResponder, NoiseError> {
    let params: snow::params::NoiseParams = NOISE_PATTERN.parse().expect("static pattern");
    let mut builder = Builder::new(params)
        .local_private_key(&options.host.private_key)
        .map_err(NoiseError::from)?;
    if let Some(ephemeral) = options.ephemeral {
        builder = builder.fixed_ephemeral_key_for_testing_only(&ephemeral.private_key);
    }
    let state = builder
        .prologue(options.prologue)
        .map_err(NoiseError::from)?
        .build_responder()
        .map_err(NoiseError::from)?;
    Ok(IkResponder { state })
}

pub struct RespondOptions<'a> {
    pub prologue: &'a [u8],
    pub host: &'a KeyPair,
    pub ephemeral: Option<&'a KeyPair>,
}

pub struct IkResponder {
    state: HandshakeState,
}

impl IkResponder {
    /// Read IK message 1: the initiator's encrypted static key and payload.
    pub fn read_message1(&mut self, message: &[u8]) -> Result<(Vec<u8>, [u8; KEY_LENGTH]), NoiseError> {
        if message.len() > MAX_MESSAGE {
            return Err(NoiseError(format!("handshake message exceeds {MAX_MESSAGE} bytes")));
        }
        let mut payload = vec![0u8; MAX_MESSAGE];
        let len = self.state.read_message(message, &mut payload).map_err(NoiseError::from)?;
        payload.truncate(len);
        let remote = self
            .state
            .get_remote_static()
            .ok_or_else(|| NoiseError("initiator static missing".into()))?;
        let remote_static: [u8; KEY_LENGTH] = remote.try_into().map_err(|_| NoiseError("bad remote static key".into()))?;
        Ok((payload, remote_static))
    }

    /// Write IK message 2 with the host hello payload; this handshake is
    /// spent either way.
    pub fn write_message2(mut self, payload: &[u8]) -> Result<(Vec<u8>, HandshakeResult), NoiseError> {
        let mut message = vec![0u8; MAX_MESSAGE];
        let len = self.state.write_message(payload, &mut message).map_err(NoiseError::from)?;
        message.truncate(len);
        let handshake_hash: [u8; 32] = self
            .state
            .get_handshake_hash()
            .try_into()
            .expect("blake2s handshake hash is 32 bytes");
        let transport = self
            .state
            .into_transport_mode()
            .map_err(NoiseError::from)?;
        Ok((message, HandshakeResult { transport, handshake_hash }))
    }
}
