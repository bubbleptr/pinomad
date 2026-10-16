// Message-image admission from packages/protocol/src/images.ts — sizes are
// computed from the base64 length, never decoded.
use crate::json::Json;
use crate::text;
use crate::u16str::U16String;

pub const MAX_IMAGES_PER_MESSAGE: u32 = 4;
/// Decoded bytes — base64 inflates by 4/3, so the wire string is larger.
pub const MAX_IMAGE_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

const IMAGE_MIME_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `^[A-Za-z0-9+/]*={0,2}$` — base64 alphabet, then at most two trailing pads.
fn is_base64(units: &[u16]) -> bool {
    let trailing = units.iter().rev().take_while(|&&u| u == b'=' as u16).count();
    if trailing > 2 {
        return false;
    }
    units[..units.len() - trailing]
        .iter()
        .all(|&u| matches!(u, 48..=57 | 65..=90 | 97..=122) || u == b'+' as u16 || u == b'/' as u16)
}

/// `imageProblem`: why a message's images can't be admitted, or None when
/// they can. Shared: the host enforces the verdict, clients may pre-check.
/// The message embeds the mime verbatim (`String(mimeType)`), so a surrogate
/// in it reaches the UI as U+FFFD — the lossy boundary.
pub fn image_problem(images: &Json) -> Option<String> {
    // JS `.length`: arrays and strings have one; anything else compares as
    // undefined and the loop runs zero times.
    let len = match images {
        Json::Array(list) => list.len(),
        Json::String(text) => text.units().len(),
        _ => 0,
    };
    if len > MAX_IMAGES_PER_MESSAGE as usize {
        return Some(format!("At most {} images per message", MAX_IMAGES_PER_MESSAGE));
    }
    for i in 0..len {
        // `images[i]` — a string input yields its i-th unit as a 1-unit string.
        let image = match images {
            Json::Array(list) => list.get(i).cloned(),
            Json::String(text) => text.units().get(i).map(|u| Json::String(U16String(vec![*u]))),
            _ => None,
        };
        let empty = Json::Null;
        let image = image.as_ref().unwrap_or(&empty);
        let mime_ok = image
            .get("mimeType")
            .and_then(Json::as_str)
            .is_some_and(|mime| {
                IMAGE_MIME_TYPES
                    .iter()
                    .any(|known| mime.units() == lit(known))
            });
        if !mime_ok {
            let mut message = lit("Unsupported image type: ");
            message.extend_from_slice(&text::string_of(image.get("mimeType")));
            message.extend_from_slice(&lit(" (use JPEG, PNG, GIF or WebP)"));
            return Some(U16String(message).to_string_lossy());
        }
        let data = image.get("data").and_then(Json::as_str);
        // `data === "" || data.length % 4 !== 0 || !BASE64.test(data)` — a
        // non-string data trips the length check (undefined % 4 is NaN).
        let valid = data.is_some_and(|data| {
            !data.units().is_empty() && data.units().len() % 4 == 0 && is_base64(data.units())
        });
        if !valid {
            return Some(format!("Image {} is not valid base64", i + 1));
        }
        let units = data.unwrap().units();
        let padding = if text::ends_with(units, &lit("==")) {
            2.0
        } else if text::ends_with(units, &lit("=")) {
            1.0
        } else {
            0.0
        };
        if (units.len() as f64) * 3.0 / 4.0 - padding > MAX_IMAGE_BYTES {
            return Some(format!("Image {} is larger than 5 MB", i + 1));
        }
    }
    None
}
