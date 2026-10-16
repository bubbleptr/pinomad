// base64url without padding — the same alphabet the TS implementation
// builds by hand (secure-channel.ts). Keys, hostIds, and relay secrets are
// all carried in it.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn to_base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let packed = (a << 16) | (b << 8) | c;
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(packed >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[packed as usize & 63] as char);
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct BadBase64;

impl std::fmt::Display for BadBase64 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid base64url")
    }
}

impl std::error::Error for BadBase64 {}

pub fn from_base64url(text: &str) -> Result<Vec<u8>, BadBase64> {
    let bytes = text.as_bytes();
    // A trailing quad of one character encodes 6 bits that can't make a byte.
    if bytes.len() % 4 == 1 {
        return Err(BadBase64);
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 3);
    for quad in bytes.chunks(4) {
        let mut packed: u32 = 0;
        for (index, &ch) in quad.iter().enumerate() {
            let value = ALPHABET.iter().position(|&a| a == ch).ok_or(BadBase64)? as u32;
            packed |= value << (18 - index * 6);
        }
        out.push((packed >> 16) as u8);
        if quad.len() > 2 {
            out.push((packed >> 8) as u8);
        }
        if quad.len() > 3 {
            out.push(packed as u8);
        }
    }
    Ok(out)
}
