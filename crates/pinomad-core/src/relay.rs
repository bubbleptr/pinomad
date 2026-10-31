// Relay constants the device client needs (packages/protocol/src/relay.ts).
// A device never registers a control channel or signs challenges — the
// pairing link hands it a ready-made `wss://relay/c/<hostId>` URL and the
// IK handshake then runs end-to-end with the host, so the only client-
// facing surface here is the close-code table: relay rejections arrive as
// socket close codes, and the splice in apps/server also forwards the
// host's own codes (a 4401 through the relay is a real 4401).
// Registration, challenge signing, and the control channel stay host-side.

/// `RELAY_CLOSE` — 46xx so relay codes never collide with the host's own
/// (UNAUTHORIZED_CLOSE_CODE = 4401 in frames.ts).
pub mod close_codes {
    /// The host's Ed25519 signature on the control channel did not verify.
    pub const BAD_SIGNATURE: u16 = 4601;
    /// The control connection's hostId is not bound to an account.
    pub const HOST_NOT_ALLOWED: u16 = 4603;
    /// A device dialed a hostId that has no registered control channel —
    /// the host is offline, not a client error.
    pub const HOST_OFFLINE: u16 = 4604;
    /// An accept channel named a connId the relay no longer tracks.
    pub const UNKNOWN_CONNECTION: u16 = 4605;
    /// The device's handshake did not complete within the server's deadline.
    pub const HANDSHAKE_TIMEOUT: u16 = 4608;
    /// This control connection was superseded by a newer registration.
    pub const REPLACED: u16 = 4609;
    /// The host did not accept the incoming device in time.
    pub const ACCEPT_TIMEOUT: u16 = 4610;
    /// A concurrent-connection cap for the host or its account is full.
    pub const TOO_MANY_CONNECTIONS: u16 = 4629;
    /// The account's relay traffic budget is spent; it refills over time.
    pub const TRAFFIC_LIMIT: u16 = 4630;
}

/// `relayHostId` — the hostId is the base64url of the host's 32-byte
/// Ed25519 public key (deliberately separate from its Noise X25519 key).
pub fn relay_host_id(ed25519_public_key: &[u8]) -> Result<String, String> {
    if ed25519_public_key.len() != 32 {
        return Err("Ed25519 public key must be 32 bytes".to_string());
    }
    Ok(crate::b64::to_base64url(ed25519_public_key))
}
