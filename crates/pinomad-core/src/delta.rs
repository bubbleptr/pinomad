// The chord delta ops a host applies to a stream's snapshot (the `ops`
// frame). Ported from @earendil-works/chord@1.2.0 `dist/delta/index.js` —
// only the parts a consumer of `applyImmutable` needs: the decoded-op
// validator, the path safety rules, and the copy-on-write apply. The wire
// codec (#-references, short forms) does not cross this boundary: the host
// emits already-decoded ops. Tracker and diff produce deltas, which a
// client never does.
//
// Every position and length in a string op counts UTF-16 code units,
// because the reference is JavaScript.

use std::rc::Rc;

use crate::json::{number_to_units, Json};
use crate::u16str::U16String;

/// A path segment: an object key or an array index, as on the wire.
#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Str(U16String),
    Num(f64),
}

impl Seg {
    /// The property name a numeric segment resolves to on an object —
    /// JS coerces the key with String(number).
    fn object_key(&self) -> Vec<u16> {
        match self {
            Seg::Str(s) => s.0.clone(),
            Seg::Num(v) => number_to_units(*v),
        }
    }
}

pub type Path = Vec<Seg>;

/// One decoded operation. Positions inside a `t`/`p` payload are validated
/// non-negative integers but kept as f64: the wire can carry values past
/// usize (1e30), which behave like "way off the end" rather than a parse
/// failure.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// `["r", value]` — replace the whole value; the only root-level op.
    Replace(Json),
    /// `["s", path, value]` — define a data property.
    Set(Path, Json),
    /// `["d", path]` — delete; a missing object key is a no-op.
    Delete(Path),
    /// `["a", path, text]` — append to a string.
    Append(Path, U16String),
    /// `["t", path, n]` — drop the first n UTF-16 code units.
    Truncate(Path, f64),
    /// `["p", path, index, remove, items]` — array splice.
    Splice(Path, f64, f64, Vec<Json>),
    /// `["m", path, permutation]` — new[i] = old[permutation[i]].
    Permute(Path, Vec<usize>),
}

/// Compare a code-unit slice with an ASCII literal without allocating.
fn units_eq(units: &[u16], text: &str) -> bool {
    units.iter().copied().eq(text.encode_utf16())
}

/// Segments that reach the prototype chain in JS; rejected as unsafe.
fn is_reserved(units: &[u16]) -> bool {
    units_eq(units, "__proto__") || units_eq(units, "constructor") || units_eq(units, "prototype")
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeltaError {
    /// assertValidOp failures: tuple arity/shape (JS throws TypeError).
    Type(String),
    /// assertSafePath / array-key violations (JS UnsafePathError).
    UnsafePath(String),
    /// resolve failures: missing own property, non-container node, bad
    /// splice target (JS PathError).
    Path(String),
}

impl std::fmt::Display for DeltaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeltaError::Type(m) | DeltaError::UnsafePath(m) | DeltaError::Path(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for DeltaError {}

fn type_error(message: &str) -> DeltaError {
    DeltaError::Type(message.to_string())
}

fn unsafe_path(segment: &Seg) -> DeltaError {
    let text = match segment {
        Seg::Str(s) => s.to_string_lossy(),
        Seg::Num(v) => crate::json::number_to_json(*v),
    };
    DeltaError::UnsafePath(format!("unsafe path segment: {text}"))
}

fn path_error(path: &[Seg]) -> DeltaError {
    // The reference reports JSON.stringify(path); close enough for messages
    // that surface in a notice or a dropped session.
    let rendered = Json::array(path.iter().map(seg_to_json).collect()).to_json();
    DeltaError::Path(format!("unresolvable path: {rendered}"))
}

fn seg_to_json(seg: &Seg) -> Json {
    match seg {
        Seg::Str(s) => Json::String(s.clone()),
        Seg::Num(v) => Json::Number(*v),
    }
}

fn is_integer(v: f64) -> bool {
    v.fract() == 0.0 && v.is_finite()
}

/// One wire path segment: a string or a number. Anything else is mapped to
/// NaN — it is not an integer, so `assert_safe_path` rejects it as unsafe,
/// the same verdict `!Number.isInteger(seg)` gives in JS.
fn seg_from_json(value: &Json) -> Seg {
    match value {
        Json::String(s) => Seg::Str(s.clone()),
        Json::Number(v) => Seg::Num(*v),
        _ => Seg::Num(f64::NAN),
    }
}

/// `assertSafePath`: string segments must not be reserved, numeric segments
/// must be non-negative integers.
fn assert_safe_path(path: &[Seg]) -> Result<(), DeltaError> {
    for seg in path {
        match seg {
            Seg::Str(s) if is_reserved(&s.0) => return Err(unsafe_path(seg)),
            Seg::Num(v) if !is_integer(*v) || *v < 0.0 => return Err(unsafe_path(seg)),
            _ => {}
        }
    }
    Ok(())
}

/// Decode one op from its JSON tuple (`assertValidOp`: decoded grammar,
/// paths inline — no `#`, no short forms).
pub fn op_from_json(value: &Json) -> Result<Op, DeltaError> {
    let tuple = value.as_array().ok_or_else(|| type_error("op is not a tuple"))?;
    let verb = tuple
        .first()
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let path_at = |index: usize, non_empty: bool| -> Result<Path, DeltaError> {
        let raw = tuple
            .get(index)
            .and_then(Json::as_array)
            .ok_or_else(|| type_error("path is not an array"))?;
        if non_empty && raw.is_empty() {
            return Err(type_error("path is empty"));
        }
        let path: Vec<Seg> = raw.iter().map(seg_from_json).collect();
        assert_safe_path(&path)?;
        Ok(path)
    };
    match verb.as_str() {
        "r" => {
            if tuple.len() != 2 {
                return Err(type_error("r arity"));
            }
            Ok(Op::Replace(tuple[1].clone()))
        }
        "s" => {
            if tuple.len() != 3 {
                return Err(type_error("s arity"));
            }
            Ok(Op::Set(path_at(1, true)?, tuple[2].clone()))
        }
        "d" => {
            if tuple.len() != 2 {
                return Err(type_error("d arity"));
            }
            Ok(Op::Delete(path_at(1, true)?))
        }
        "a" => {
            if tuple.len() != 3 || tuple[2].as_str().is_none() {
                return Err(type_error("a shape"));
            }
            Ok(Op::Append(path_at(1, true)?, tuple[2].as_str().unwrap().clone()))
        }
        "t" => {
            let count = tuple.get(2).and_then(Json::as_number);
            if tuple.len() != 3 || !matches!(count, Some(v) if is_integer(v) && v >= 0.0) {
                return Err(type_error("t shape"));
            }
            Ok(Op::Truncate(path_at(1, true)?, count.unwrap()))
        }
        "p" => {
            if tuple.len() != 5 {
                return Err(type_error("p arity"));
            }
            let index = tuple[2].as_number();
            let remove = tuple[3].as_number();
            match (index, remove) {
                (Some(i), Some(r)) if is_integer(i) && i >= 0.0 && is_integer(r) && r >= 0.0 => {}
                _ => return Err(type_error("p index")),
            }
            let items = tuple[4]
                .as_array()
                .ok_or_else(|| type_error("p items"))?
                .as_ref()
                .clone();
            Ok(Op::Splice(path_at(1, false)?, index.unwrap(), remove.unwrap(), items))
        }
        "m" => {
            if tuple.len() != 3 {
                return Err(type_error("m arity"));
            }
            let path = path_at(1, false)?;
            let perm = tuple[2]
                .as_array()
                .ok_or_else(|| type_error("m permutation is not an array"))?;
            let mut seen = vec![false; perm.len()];
            let mut permutation = Vec::with_capacity(perm.len());
            for item in perm.iter() {
                let index = item
                    .as_number()
                    .filter(|v| is_integer(*v) && *v >= 0.0 && *v < perm.len() as f64)
                    .map(|v| v as usize);
                match index {
                    Some(i) if !seen[i] => {
                        seen[i] = true;
                        permutation.push(i);
                    }
                    _ => return Err(type_error("m permutation is not a bijection")),
                }
            }
            Ok(Op::Permute(path, permutation))
        }
        _ => Err(type_error(&format!("unknown op verb: {verb}"))),
    }
}

/// A numeric segment as an array index; clamped instead of overflowing for
/// huge wire values — every use below compares against an in-memory length.
fn as_index(v: f64) -> usize {
    if v >= usize::MAX as f64 {
        usize::MAX
    } else {
        v as usize
    }
}

/// `applyImmutable(target, ops)` from chord 1.2.0: validate every op, then
/// replay copy-on-write — a container is cloned when first touched, so the
/// previous value is never mutated. Rc sharing makes the clone-once
/// bookkeeping of the JS WeakSet version unnecessary: `Rc::make_mut`
/// already mutates in place only when this replay produced the container.
pub fn apply_immutable(target: &Json, ops: &[Op]) -> Result<Json, DeltaError> {
    let mut root = target.clone();
    for op in ops {
        apply_one(&mut root, op)?;
    }
    Ok(root)
}

fn apply_one(root: &mut Json, op: &Op) -> Result<(), DeltaError> {
    match op {
        Op::Replace(value) => {
            *root = value.clone();
            return Ok(());
        }
        Op::Splice(path, index, remove, items) => {
            assert_safe_path(path)?;
            let target = resolve_mut(root, path)?;
            let array = match target {
                Json::Array(items_rc) => Rc::make_mut(items_rc),
                _ => return Err(path_error(path)),
            };
            // Array.prototype.splice clamps both bounds to the length.
            let start = as_index(*index).min(array.len());
            let deleted = as_index(*remove).min(array.len() - start);
            array.splice(start..start + deleted, items.iter().cloned());
            return Ok(());
        }
        Op::Permute(path, permutation) => {
            assert_safe_path(path)?;
            let target = resolve_mut(root, path)?;
            let array = match target {
                Json::Array(items_rc) => Rc::make_mut(items_rc),
                _ => return Err(path_error(path)),
            };
            if array.len() != permutation.len()
                || permutation.iter().any(|source| *source >= array.len())
            {
                // op_from_json rejects these, but a hand-built Permute can
                // carry out-of-range sources — the reference would just
                // smear undefined over the slots, which has no Json
                // counterpart, so report instead of panic.
                return Err(path_error(path));
            }
            let previous = array.clone();
            for (index, slot) in array.iter_mut().enumerate() {
                *slot = previous[permutation[index]].clone();
            }
            return Ok(());
        }
        _ => {}
    }
    let (path, key) = match op {
        Op::Set(path, _) | Op::Delete(path) | Op::Append(path, _) | Op::Truncate(path, _) => {
            assert_safe_path(path)?;
            // op_from_json rejects empty paths, but a hand-built Op (the
            // public enum) can carry one — the reference would read
            // path.at(-1) as undefined and reach the unsafe-path verdict,
            // so report that rather than panic.
            let key = path.last().cloned().ok_or_else(|| path_error(path))?;
            (path.clone(), key)
        }
        _ => unreachable!(),
    };
    let parent_path = &path[..path.len() - 1];
    let parent = resolve_mut(root, parent_path)?;
    match parent {
        Json::Array(items_rc) => {
            let index = match &key {
                Seg::Num(v) => as_index(*v),
                _ => return Err(unsafe_path(&key)),
            };
            let items = Rc::make_mut(items_rc);
            // assertIndexInRange runs before the verb dispatch: an index may
            // reach one past the end (append), never further — sparse arrays
            // do not survive a JSON round trip.
            if index > items.len() {
                return Err(unsafe_path(&key));
            }
            match op {
                Op::Set(_, value) => {
                    if index == items.len() {
                        items.push(value.clone());
                    } else {
                        items[index] = value.clone();
                    }
                }
                Op::Delete(_) => {
                    if index >= items.len() {
                        return Err(path_error(&path));
                    }
                    items.remove(index);
                }
                Op::Append(_, text) => {
                    let current = items
                        .get(index)
                        .and_then(Json::as_str)
                        .ok_or_else(|| path_error(&path))?;
                    let mut joined = current.0.clone();
                    joined.extend_from_slice(&text.0);
                    items[index] = Json::String(U16String(joined));
                }
                Op::Truncate(_, count) => {
                    let current = items
                        .get(index)
                        .and_then(Json::as_str)
                        .ok_or_else(|| path_error(&path))?;
                    let keep = as_index(*count).min(current.0.len());
                    items[index] = Json::String(U16String(current.0[keep..].to_vec()));
                }
                _ => unreachable!(),
            }
        }
        Json::Object(object_rc) => {
            let key_units = key.object_key();
            let object = Rc::make_mut(object_rc);
            match op {
                Op::Set(_, value) => object.set(U16String(key_units), value.clone()),
                Op::Delete(_) => object.remove(&key_units),
                Op::Append(_, text) => {
                    let current = object
                        .get(&key_units)
                        .and_then(Json::as_str)
                        .ok_or_else(|| path_error(&path))?;
                    let mut joined = current.0.clone();
                    joined.extend_from_slice(&text.0);
                    object.set(U16String(key_units), Json::String(U16String(joined)));
                }
                Op::Truncate(_, count) => {
                    let current = object
                        .get(&key_units)
                        .and_then(Json::as_str)
                        .ok_or_else(|| path_error(&path))?;
                    let keep = as_index(*count).min(current.0.len());
                    object.set(
                        U16String(key_units),
                        Json::String(U16String(current.0[keep..].to_vec())),
                    );
                }
                _ => unreachable!(),
            }
        }
        // resolve() requires the parent to be a container.
        _ => return Err(path_error(&path)),
    }
    Ok(())
}

/// Walk `path` resolving each segment, cloning containers on first touch —
/// `resolve` + `copyContainers` from the reference. The returned node is
/// uniquely owned by this replay (or cloned), so callers mutate freely.
fn resolve_mut<'a>(root: &'a mut Json, path: &[Seg]) -> Result<&'a mut Json, DeltaError> {
    let mut node = root;
    for seg in path {
        // copyContainers: hasOwn → array key type → container.
        let child = match node {
            Json::Array(items_rc) => match seg {
                Seg::Str(s) => {
                    // Own-property check runs first: a string key an array
                    // owns (an in-range index or "length") fails the numeric
                    // type check; anything else is a plain miss.
                    let index_hit = crate::json::array_index(&s.0)
                        .map(|index| index < items_rc.len() as u64)
                        .unwrap_or(false);
                    return Err(if index_hit || units_eq(&s.0, "length") {
                        unsafe_path(seg)
                    } else {
                        path_error(path)
                    });
                }
                Seg::Num(v) => {
                    let index = as_index(*v);
                    let items = Rc::make_mut(items_rc);
                    if index >= items.len() {
                        return Err(path_error(path));
                    }
                    &mut items[index]
                }
            },
            Json::Object(object_rc) => {
                let key = seg.object_key();
                let object = Rc::make_mut(object_rc);
                object.get_mut(&key).ok_or_else(|| path_error(path))?
            }
            _ => return Err(path_error(path)),
        };
        if !child.is_container() {
            return Err(path_error(path));
        }
        node = child;
    }
    Ok(node)
}
