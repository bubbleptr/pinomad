//! Deterministic payloads shared by the iOS client and the Node-side Noise
//! peer. The frame is deliberately large enough to span many 64 KiB Noise
//! records (the real secure-channel record bound).

/// 4 MiB, including the JSON envelope. A single business frame, not a batch.
pub const BULK_FRAME_BYTES: usize = 4 * 1024 * 1024;

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// A JSON text frame whose `data` field fills the frame to exactly
/// [`BULK_FRAME_BYTES`]. The same function runs on both ends, so equality of
/// the whole string is a byte-for-byte check of the Noise record assembly.
pub fn bulk_frame(seed: u64) -> String {
    let prefix = format!("{{\"kind\":\"bulk\",\"seed\":{seed},\"data\":\"");
    let suffix = "\"}";
    let fill = BULK_FRAME_BYTES - prefix.len() - suffix.len();
    let mut body = String::with_capacity(BULK_FRAME_BYTES);
    body.push_str(&prefix);
    for i in 0..fill {
        let index = ((i as u64).wrapping_mul(37).wrapping_add(seed)) % ALPHABET.len() as u64;
        body.push(ALPHABET[index as usize] as char);
    }
    body.push_str(suffix);
    debug_assert_eq!(body.len(), BULK_FRAME_BYTES);
    body
}

pub fn ack_frame(seed: u64, received_bytes: usize) -> String {
    format!("{{\"kind\":\"ack\",\"seed\":{seed},\"receivedBytes\":{received_bytes}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_exact_and_reproducible() {
        let a = bulk_frame(7);
        let b = bulk_frame(7);
        assert_eq!(a.len(), BULK_FRAME_BYTES);
        assert_eq!(a, b);
        assert!(a.starts_with("{\"kind\":\"bulk\",\"seed\":7,\"data\":\""));
        assert!(a.ends_with("\"}"));
    }

    #[test]
    fn frame_differs_by_seed() {
        assert_ne!(bulk_frame(1), bulk_frame(2));
    }
}
