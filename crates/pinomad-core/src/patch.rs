// A unified-patch parser — the Rust port of `parsePatch` in
// packages/client/src/patch.ts, kept field-for-field identical by the
// rust-vectors fixtures (ADR-0024 §6). The `changes` call's patch is parsed
// here so Swift receives typed files, never the raw unified diff.

/// A parsed patch line's role — the strings the TS reference emits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum PatchLineKind {
    Add,
    Del,
    Ctx,
    Meta,
}

impl PatchLineKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            PatchLineKind::Add => "add",
            PatchLineKind::Del => "del",
            PatchLineKind::Ctx => "ctx",
            PatchLineKind::Meta => "meta",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PatchLine {
    pub kind: PatchLineKind,
    /// The full line including its leading ` `/`+`/`-`/`@@` marker.
    pub text: String,
}

/// One file in a parsed patch — the `ParsedFile` shape.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PatchFile {
    /// The new-side path; a deleted file falls back to the old one.
    pub path: String,
    /// The old-side path when it differs (renames, copies) or was given.
    pub old_path: Option<String>,
    pub is_new: bool,
    pub is_deleted: bool,
    pub binary: bool,
    pub additions: u64,
    pub deletions: u64,
    /// Hunk `@@` headers and body lines — header/extended lines are
    /// structure and never land here.
    pub lines: Vec<PatchLine>,
}

fn fresh_file(path: String) -> PatchFile {
    PatchFile {
        path,
        old_path: None,
        is_new: false,
        is_deleted: false,
        binary: false,
        additions: 0,
        deletions: 0,
        lines: Vec::new(),
    }
}

fn push_line(file: &mut PatchFile, kind: PatchLineKind, text: &str) {
    file.lines.push(PatchLine {
        kind,
        text: text.to_string(),
    });
}

/// `line.slice(marker.length + 1 + prefix.length)` — or without the prefix
/// when the header carries a bare path. All markers are ASCII, so byte
/// slicing is exact.
fn strip_prefix<'a>(line: &'a str, marker: &str, prefix: &str) -> &'a str {
    let head = format!("{marker} {prefix}");
    if line.starts_with(&head) {
        &line[head.len()..]
    } else {
        &line[marker.len() + 1..]
    }
}

/// The leading run of ASCII digits, parsed saturating — a `@@` count past
/// i64::MAX would saturate rather than fail like the reference's Number().
fn take_digits(s: &str) -> Option<(&str, i64)> {
    let len = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if len == 0 {
        return None;
    }
    let value = s[..len].parse::<i64>().unwrap_or(i64::MAX);
    Some((&s[len..], value))
}

/// `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/` — the hunk's owed line
/// counts for the old and new sides; starts are parsed but unused, like the
/// reference.
fn hunk_counts(line: &str) -> Option<(i64, i64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (rest, _old_start) = take_digits(rest)?;
    let (rest, old_count) = match rest.strip_prefix(',') {
        Some(with_count) => take_digits(with_count)?,
        None => (rest, 1),
    };
    let rest = rest.strip_prefix(" +")?;
    let (rest, _new_start) = take_digits(rest)?;
    let (rest, new_count) = match rest.strip_prefix(',') {
        Some(with_count) => take_digits(with_count)?,
        None => (rest, 1),
    };
    rest.starts_with(" @@").then_some((old_count, new_count))
}

/// `/^diff --git a\/(\S+) b\/(\S+)$/` — the new-side path, or `None` when the
/// header doesn't fit that shape (the caller falls back to the raw tail).
fn git_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git a/")?;
    let sep = rest.find(" b/")?;
    let (old, new) = (&rest[..sep], &rest[sep + 3..]);
    let fits = |part: &str| !part.is_empty() && !part.chars().any(char::is_whitespace);
    (fits(old) && fits(new)).then(|| new.to_string())
}

fn push_file(files: &mut Vec<PatchFile>, file: &mut Option<PatchFile>) {
    let Some(done) = file.take() else { return };
    let mut done = done;
    // A deleted file carries no `+++` name — fall back to the old one.
    if done.path.is_empty() {
        if let Some(old) = done.old_path.clone() {
            done.path = old;
        }
    }
    files.push(done);
}

/// Parse unified diff output — `git diff` (`diff --git` headers) and the
/// `diff` package's `createPatch` shape (`Index:`/`---`/`+++` without git
/// headers). Inside a hunk every line is body: the `@@ -a,b +c,d @@` counts
/// decide when it ends, so a removed `-- comment` or added `+++ x` line
/// can't masquerade as a file header.
pub fn parse_patch(patch: &str) -> Vec<PatchFile> {
    let mut files: Vec<PatchFile> = Vec::new();
    let mut file: Option<PatchFile> = None;
    // Lines the current hunk still owes, for old and new sides. While either
    // is positive, every line belongs to the hunk regardless of its prefix.
    let mut remaining_old: i64 = 0;
    let mut remaining_new: i64 = 0;
    // A file opened by `diff --git` still expects its own `---` header line.
    let mut needs_old_header = false;

    for line in patch.split('\n') {
        if (remaining_old > 0 || remaining_new > 0) && file.is_some() {
            let current = file.as_mut().expect("file is some");
            if line.starts_with('\\') {
                // "\ No newline at end of file" consumes nothing on either side.
                push_line(current, PatchLineKind::Ctx, line);
            } else if line.starts_with('+') {
                current.additions += 1;
                push_line(current, PatchLineKind::Add, line);
                remaining_new -= 1;
            } else if line.starts_with('-') {
                current.deletions += 1;
                push_line(current, PatchLineKind::Del, line);
                remaining_old -= 1;
            } else {
                // " ctx" and empty lines count against both sides.
                push_line(current, PatchLineKind::Ctx, line);
                remaining_old -= 1;
                remaining_new -= 1;
            }
            continue;
        }
        if line.starts_with("@@") {
            if let (Some(current), Some((old, new))) = (file.as_mut(), hunk_counts(line)) {
                remaining_old = old;
                remaining_new = new;
                push_line(current, PatchLineKind::Meta, line);
            }
            continue;
        }
        if line.starts_with("diff --git ") {
            push_file(&mut files, &mut file);
            let path = git_path(line).unwrap_or_else(|| line["diff --git ".len()..].to_string());
            file = Some(fresh_file(path));
            needs_old_header = true;
            continue;
        }
        if line.starts_with("--- ") {
            if file.is_some() && needs_old_header {
                // The current `diff --git` file's own `---` header.
                needs_old_header = false;
                let current = file.as_mut().expect("file is some");
                if line == "--- /dev/null" {
                    current.is_new = true;
                } else {
                    current.old_path = Some(strip_prefix(line, "---", "a/").to_string());
                }
            } else {
                push_file(&mut files, &mut file);
                let mut next = fresh_file(String::new());
                if line == "--- /dev/null" {
                    next.is_new = true;
                } else {
                    next.old_path = Some(strip_prefix(line, "---", "a/").to_string());
                }
                file = Some(next);
            }
            continue;
        }
        let Some(current) = file.as_mut() else { continue };
        if line.starts_with("+++ ") {
            if line == "+++ /dev/null" {
                current.is_deleted = true;
            } else {
                current.path = strip_prefix(line, "+++", "b/").to_string();
            }
        } else if line.starts_with("new file mode") {
            current.is_new = true;
        } else if line.starts_with("deleted file mode") {
            current.is_deleted = true;
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            current.old_path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("rename to ") {
            current.path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("copy from ") {
            current.old_path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("copy to ") {
            current.path = rest.to_string();
        } else if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
            current.binary = true;
        }
        // Any other header/extended line (index, modes, Index:, ====,
        // similarity, binary payload) is structure — skipped, not content.
    }
    push_file(&mut files, &mut file);
    files
}
