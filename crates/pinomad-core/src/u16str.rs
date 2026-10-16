// A string as a sequence of UTF-16 code units. The host speaks JavaScript:
// its strings may contain unpaired surrogates (device names are truncated to
// 64 code units, chord string ops slice mid-code-point), and a JSON parser
// that insists on well-formed UTF-16 — serde_json::Value included — would
// reject data the host legitimately sends (ADR-0024 §4).

use std::fmt;

/// UTF-16 code units, possibly containing unpaired surrogates.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct U16String(pub Vec<u16>);

impl U16String {
    pub fn from_str(text: &str) -> Self {
        Self(text.encode_utf16().collect())
    }

    pub fn units(&self) -> &[u16] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The string Rust code can consume: unpaired surrogates become U+FFFD,
    /// which is also what the apps do when handing text to the platform UI.
    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }

    /// Strict conversion; fails on unpaired surrogates.
    pub fn to_string(&self) -> Result<String, std::string::FromUtf16Error> {
        String::from_utf16(&self.0)
    }

    /// What `String(value)` does in JavaScript, for values that are not
    /// already strings — used wherever the TS reference interpolates an
    /// arbitrary JSON value into a name or message.
    pub fn js_string(value: &crate::json::Json) -> Self {
        use crate::json::Json;
        match value {
            Json::Null => Self::from_str("null"),
            Json::Bool(v) => Self::from_str(if *v { "true" } else { "false" }),
            Json::Number(v) => Self(crate::json::number_to_units(*v)),
            Json::String(s) => s.clone(),
            Json::Array(items) => {
                // Array#toString joins element strings with commas.
                let mut out = Vec::new();
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(b',' as u16);
                    }
                    // null and undefined read as the empty string here.
                    match item {
                        Json::Null => {}
                        other => out.extend_from_slice(&Self::js_string(other).0),
                    }
                }
                Self(out)
            }
            Json::Object(_) => Self::from_str("[object Object]"),
        }
    }
}

impl fmt::Display for U16String {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_string_lossy())
    }
}

impl From<&str> for U16String {
    fn from(text: &str) -> Self {
        Self::from_str(text)
    }
}

impl From<String> for U16String {
    fn from(text: String) -> Self {
        Self::from_str(&text)
    }
}
