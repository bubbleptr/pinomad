// The JSON value type every stream's state is kept in (ADR-0024 §4).
//
// Strings are UTF-16 code unit sequences, so anything a JavaScript peer can
// hold survives parse → delta ops → re-encode untouched, including the lone
// surrogates the host produces on purpose (device names truncated at 64 code
// units). Encoding is byte-identical to JSON.stringify — the TS side records
// comparison vectors to keep it that way.
//
// Objects mimic JS property order: canonical array-index keys first in
// ascending order, then the rest in insertion order. serde_json is
// deliberately not used anywhere in the streaming state path.

use std::rc::Rc;

use crate::u16str::U16String;

/// The largest nesting `parse` accepts. Far above anything the host sends;
/// capped this low because the parser is recursive — deep enough for real
/// documents, shallow enough to fail as an error on small FFI thread
/// stacks instead of overflowing them.
const MAX_DEPTH: usize = 512;

#[derive(Clone, Debug)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(U16String),
    Array(Rc<Vec<Json>>),
    Object(Rc<JsonObject>),
}

/// An object's entries in insertion order. The JS enumeration order —
/// integer indices ascending, then the rest in insertion order — is computed
/// at read time, not stored, so a `set` only ever appends or replaces.
#[derive(Clone, Debug, Default)]
pub struct JsonObject {
    entries: Vec<(U16String, Json)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub offset: usize,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for ParseError {}

impl JsonObject {
    pub fn new() -> Self {
        Self::default()
    }

    /// The value under `key`, or None — Object.hasOwn semantics.
    pub fn get(&self, key: &[u16]) -> Option<&Json> {
        self.entries
            .iter()
            .find(|(k, _)| k.units() == key)
            .map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &[u16]) -> Option<&mut Json> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k.units() == key)
            .map(|(_, v)| v)
    }

    /// Define a data property: replace in place when present, append when
    /// new. Output order is computed at enumeration, so no reordering here.
    pub fn set(&mut self, key: U16String, value: Json) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some((_, slot)) => *slot = value,
            None => self.entries.push((key, value)),
        }
    }

    /// `delete obj[key]`: absent keys are a no-op, like the JS operator.
    pub fn remove(&mut self, key: &[u16]) {
        self.entries.retain(|(k, _)| k.units() != key);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Entries in JavaScript enumeration order: canonical array-index keys
    /// ascending, then every other key in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&U16String, &Json)> {
        JsOrder {
            indices: sorted_index_positions(&self.entries),
            rest: non_index_positions(&self.entries),
            entries: &self.entries,
            pos: 0,
        }
    }

    /// Insertion order — how the entries are stored, not how JS enumerates.
    pub fn iter_insertion(&self) -> impl Iterator<Item = (&U16String, &Json)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }
}

struct JsOrder<'a> {
    indices: Vec<usize>,
    rest: Vec<usize>,
    entries: &'a [(U16String, Json)],
    pos: usize,
}

impl<'a> Iterator for JsOrder<'a> {
    type Item = (&'a U16String, &'a Json);
    fn next(&mut self) -> Option<Self::Item> {
        if self.pos < self.indices.len() {
            let (k, v) = &self.entries[self.indices[self.pos]];
            self.pos += 1;
            Some((k, v))
        } else if self.pos - self.indices.len() < self.rest.len() {
            let (k, v) = &self.entries[self.rest[self.pos - self.indices.len()]];
            self.pos += 1;
            Some((k, v))
        } else {
            None
        }
    }
}

fn sorted_index_positions(entries: &[(U16String, Json)]) -> Vec<usize> {
    let mut indexed: Vec<(u64, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(pos, (k, _))| array_index(k.units()).map(|index| (index, pos)))
        .collect();
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, pos)| pos).collect()
}

fn non_index_positions(entries: &[(U16String, Json)]) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(pos, (k, _))| (array_index(k.units()).is_none()).then_some(pos))
        .collect()
}

/// A canonical array-index key: decimal digits, no leading zeros, value below
/// 2^32-1. JS puts these first in enumeration order.
pub fn array_index(units: &[u16]) -> Option<u64> {
    if units.is_empty() || units.len() > 10 {
        return None;
    }
    if units.len() > 1 && units[0] == b'0' as u16 {
        return None;
    }
    let mut value: u64 = 0;
    for &unit in units {
        if !(unit >= b'0' as u16 && unit <= b'9' as u16) {
            return None;
        }
        value = value * 10 + (unit - b'0' as u16) as u64;
    }
    // Indices run up to 2^32-2; 4294967295 is not an index.
    (value <= 4_294_967_294).then_some(value)
}

impl Json {
    pub fn object() -> Self {
        Json::Object(Rc::new(JsonObject::new()))
    }

    pub fn array(items: Vec<Json>) -> Self {
        Json::Array(Rc::new(items))
    }

    /// `JSON.parse(text)`; the input is UTF-8 — the record layer already
    /// rejects invalid UTF-8 — and `\uXXXX` escapes may carry unpaired
    /// surrogates, which land in the string as-is.
    pub fn parse(text: &str) -> Result<Json, ParseError> {
        let mut parser = Parser { bytes: text.as_bytes(), pos: 0 };
        parser.skip_ws();
        let value = parser.value(0)?;
        parser.skip_ws();
        if parser.pos != parser.bytes.len() {
            return Err(parser.error("unexpected trailing input"));
        }
        Ok(value)
    }

    /// `JSON.stringify(value)`: byte-identical output, including the escaping
    /// of lone surrogates as `\uXXXX` (well-formed stringify since ES2019).
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Number(v) => out.push_str(&number_to_json(*v)),
            Json::String(units) => write_json_string(units, out),
            Json::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Object(object) => {
                out.push('{');
                for (index, (key, value)) in object.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_json_string(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Json::Object(_))
    }

    /// Truthiness as JS sees it — used where the reference implementation
    /// branches on a bare value (e.g. `frame.ok`).
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(v) => *v,
            Json::Number(v) => *v != 0.0 && !v.is_nan(),
            Json::String(s) => !s.is_empty(),
            Json::Array(_) | Json::Object(_) => true,
        }
    }

    /// Object member access; anything else answers None like a missed
    /// `Object.hasOwn`, which is how the reference's property reads miss.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(object) => object.get(&U16String::from_str(key).0),
            _ => None,
        }
    }

    pub fn get_units(&self, key: &[u16]) -> Option<&Json> {
        match self {
            Json::Object(object) => object.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&U16String> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Json::Number(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Rc<Vec<Json>>> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Rc<JsonObject>> {
        match self {
            Json::Object(object) => Some(object),
            _ => None,
        }
    }

    /// `typeof value === "object" && value !== null` — the record check the
    /// reference guards frames with (arrays are objects there, but the
    /// frame-level checks exclude them; callers pick).
    pub fn is_container(&self) -> bool {
        matches!(self, Json::Array(_) | Json::Object(_))
    }
}

impl PartialEq for Json {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Json::Null, Json::Null) => true,
            (Json::Bool(a), Json::Bool(b)) => a == b,
            (Json::Number(a), Json::Number(b)) => {
                if a.is_nan() && b.is_nan() {
                    true
                } else {
                    a == b
                }
            }
            (Json::String(a), Json::String(b)) => a == b,
            (Json::Array(a), Json::Array(b)) => a == b,
            (Json::Object(a), Json::Object(b)) => {
                a.len() == b.len() && a.iter().zip(b.iter()).all(|((ka, va), (kb, vb))| ka == kb && va == vb)
            }
            _ => false,
        }
    }
}

/// `===` — strict equality as the reference uses it on raw values: numbers
/// compare by value (NaN never equals, -0 equals +0), strings by units, and
/// containers by reference, matching JavaScript's object identity.
pub fn js_strict_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Null, Json::Null) => true,
        (Json::Bool(x), Json::Bool(y)) => x == y,
        (Json::Number(x), Json::Number(y)) => x == y, // NaN != NaN
        (Json::String(x), Json::String(y)) => x == y,
        (Json::Array(x), Json::Array(y)) => Rc::ptr_eq(x, y),
        (Json::Object(x), Json::Object(y)) => Rc::ptr_eq(x, y),
        _ => false,
    }
}

/// SameValueZero — the comparison `Map`, `Set`, and `Array#includes` apply:
/// strict equality except that NaN counts as equal to itself.
pub fn same_value_zero(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) if x.is_nan() && y.is_nan() => true,
        _ => js_strict_eq(a, b),
    }
}

/// A JavaScript value usable as a `Map`/`Set` key — the SameValueZero identity
/// `results.get(callId)`-style lookups in the reference rely on. Objects key
/// by reference identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum JsKey {
    /// `undefined` — an absent property read; distinct from JSON null, like
    /// JS Map keys (`map.get(undefined)` misses a `null` key).
    Undefined,
    Null,
    Bool(bool),
    /// Canonical bit pattern: -0 and +0 fold together, every NaN shares one.
    Number(u64),
    Str(Vec<u16>),
    /// Reference identity, like JS Map keys on objects.
    Object(usize),
}

impl JsKey {
    pub fn of(value: Option<&Json>) -> JsKey {
        match value {
            None => JsKey::Undefined,
            Some(Json::Null) => JsKey::Null,
            Some(Json::Bool(v)) => JsKey::Bool(*v),
            Some(Json::Number(v)) => {
                let bits = if v.is_nan() {
                    f64::NAN.to_bits()
                } else if *v == 0.0 {
                    0
                } else {
                    v.to_bits()
                };
                JsKey::Number(bits)
            }
            Some(Json::String(s)) => JsKey::Str(s.units().to_vec()),
            Some(Json::Array(v)) => JsKey::Object(Rc::as_ptr(v) as usize),
            Some(Json::Object(v)) => JsKey::Object(Rc::as_ptr(v) as usize),
        }
    }
}

impl From<&str> for Json {
    fn from(text: &str) -> Self {
        Json::String(U16String::from_str(text))
    }
}

impl From<String> for Json {
    fn from(text: String) -> Self {
        Json::String(U16String::from_str(&text))
    }
}

impl From<f64> for Json {
    fn from(value: f64) -> Self {
        Json::Number(value)
    }
}

impl From<u32> for Json {
    fn from(value: u32) -> Self {
        Json::Number(value as f64)
    }
}

impl From<u64> for Json {
    fn from(value: u64) -> Self {
        Json::Number(value as f64)
    }
}

impl From<bool> for Json {
    fn from(value: bool) -> Self {
        Json::Bool(value)
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn error(&self, message: &str) -> ParseError {
        ParseError { message: message.to_string(), offset: self.pos }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.error("JSON too deeply nested"));
        }
        match self.peek() {
            Some(b'n') => self.keyword(b"null", Json::Null),
            Some(b't') => self.keyword(b"true", Json::Bool(true)),
            Some(b'f') => self.keyword(b"false", Json::Bool(false)),
            Some(b'"') => self.string().map(Json::String),
            Some(b'[') => {
                self.pos += 1;
                let mut items = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(Json::Array(Rc::new(items)));
                }
                loop {
                    self.skip_ws();
                    items.push(self.value(depth + 1)?);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(Json::Array(Rc::new(items)));
                        }
                        _ => return Err(self.error("expected ',' or ']'")),
                    }
                }
            }
            Some(b'{') => {
                self.pos += 1;
                let mut object = JsonObject::new();
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(Json::Object(Rc::new(object)));
                }
                loop {
                    self.skip_ws();
                    if self.peek() != Some(b'"') {
                        return Err(self.error("expected string key"));
                    }
                    let key = self.string()?;
                    self.skip_ws();
                    if self.peek() != Some(b':') {
                        return Err(self.error("expected ':'"));
                    }
                    self.pos += 1;
                    self.skip_ws();
                    let value = self.value(depth + 1)?;
                    object.set(key, value);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b'}') => {
                            self.pos += 1;
                            return Ok(Json::Object(Rc::new(object)));
                        }
                        _ => return Err(self.error("expected ',' or '}'")),
                    }
                }
            }
            Some(_) => self.number(),
            None => Err(self.error("unexpected end of input")),
        }
    }

    fn keyword(&mut self, word: &[u8], value: Json) -> Result<Json, ParseError> {
        if self.bytes[self.pos..].starts_with(word) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(self.error("invalid literal"))
        }
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.error("invalid number")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos]).expect("number slice is ascii");
        let value: f64 = text.parse().map_err(|_| self.error("invalid number"))?;
        Ok(Json::Number(value))
    }

    fn string(&mut self) -> Result<U16String, ParseError> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.pos += 1;
        let mut units: Vec<u16> = Vec::new();
        loop {
            let byte = match self.peek() {
                Some(byte) => byte,
                None => return Err(self.error("unterminated string")),
            };
            match byte {
                b'"' => {
                    self.pos += 1;
                    return Ok(U16String(units));
                }
                b'\\' => {
                    self.pos += 1;
                    let escape = self.peek().ok_or_else(|| self.error("unterminated escape"))?;
                    self.pos += 1;
                    match escape {
                        b'"' => units.push(b'"' as u16),
                        b'\\' => units.push(b'\\' as u16),
                        b'/' => units.push(b'/' as u16),
                        b'b' => units.push(0x08),
                        b'f' => units.push(0x0c),
                        b'n' => units.push(0x0a),
                        b'r' => units.push(0x0d),
                        b't' => units.push(0x09),
                        b'u' => {
                            let code = self.hex4()?;
                            units.push(code);
                        }
                        _ => return Err(self.error("invalid escape")),
                    }
                }
                0x00..=0x1f => return Err(self.error("control character in string")),
                0x20..=0x7f => {
                    units.push(byte as u16);
                    self.pos += 1;
                }
                _ => {
                    // A multi-byte UTF-8 sequence: decode the scalar, then
                    // encode to UTF-16 (a supplementary char is two units).
                    // The input was a &str — already valid UTF-8 — so the
                    // leading byte's width tells the char's length and one
                    // tiny slice decodes it; re-validating the whole rest
                    // here would make non-ASCII strings O(n²).
                    let first = self.bytes[self.pos];
                    let width = if first >= 0xF0 { 4 } else if first >= 0xE0 { 3 } else { 2 };
                    let ch = std::str::from_utf8(&self.bytes[self.pos..self.pos + width])
                        .map_err(|_| self.error("invalid UTF-8"))?
                        .chars()
                        .next()
                        .expect("non-empty input");
                    units.extend(ch.encode_utf16(&mut [0u16; 2]).iter().copied());
                    self.pos += width;
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(self.error("truncated \\u escape"));
        }
        let mut value: u16 = 0;
        for index in 0..4 {
            let byte = self.bytes[self.pos + index];
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(self.error("invalid \\u escape")),
            };
            value = value * 16 + digit as u16;
        }
        self.pos += 4;
        Ok(value)
    }
}

fn write_json_string(units: &U16String, out: &mut String) {
    out.push('"');
    let mut index = 0;
    let raw = units.units();
    while index < raw.len() {
        let unit = raw[index];
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0a => out.push_str("\\n"),
            0x0c => out.push_str("\\f"),
            0x0d => out.push_str("\\r"),
            0x00..=0x1f => {
                out.push_str(&format!("\\u{unit:04x}"));
            }
            0xd800..=0xdbff if index + 1 < raw.len() && (0xdc00..=0xdfff).contains(&raw[index + 1]) => {
                // A surrogate pair is a real character; JSON.stringify emits
                // it raw, not escaped.
                let high = (unit as u32) - 0xd800;
                let low = (raw[index + 1] as u32) - 0xdc00;
                let scalar = 0x10000 + ((high << 10) | low);
                out.push(char::from_u32(scalar).expect("surrogate pair is a scalar"));
                index += 1;
            }
            0xd800..=0xdfff => {
                // Lone surrogate: well-formed stringify escapes it so the
                // output is always valid Unicode text.
                out.push_str(&format!("\\u{unit:04x}"));
            }
            _ => {
                if let Some(ch) = char::from_u32(unit as u32) {
                    out.push(ch);
                }
            }
        }
        index += 1;
    }
    out.push('"');
}

/// `String(number)` digits — also the canonical key name a numeric path
/// segment resolves to on an object (String(1e30) is "1e+30").
pub fn number_to_json(value: f64) -> String {
    if value.is_nan() || value.is_infinite() {
        // JSON.stringify turns non-finite numbers into null.
        return "null".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    // `{:e}` yields the shortest round-trip mantissa: d[.ddd]e±x. Split it
    // into digits + exponent and re-position per ECMAScript Number#toString.
    let text = format!("{value:e}");
    let (negative, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.as_str()),
    };
    let epos = body.find('e').expect("lowerexp always carries an exponent");
    let exponent: i32 = body[epos + 1..].parse().expect("lowerexp exponent parses");
    let digits: String = body[..epos].chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // n is the position of the decimal point: value = 0.digits × 10^n.
    let n = exponent + 1;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if n <= 0 && n > -6 {
        out.push_str("0.");
        for _ in 0..-n {
            out.push('0');
        }
        out.push_str(&digits);
    } else if n <= 21 && n >= k {
        out.push_str(&digits);
        for _ in 0..n - k {
            out.push('0');
        }
    } else if n > 0 && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let exp = n - 1;
        if exp >= 0 {
            out.push('+');
        }
        out.push_str(&exp.to_string());
    }
    out
}

/// `String(number)` as code units, for building keys and messages.
pub fn number_to_units(value: f64) -> Vec<u16> {
    number_to_json(value).encode_utf16().collect()
}
