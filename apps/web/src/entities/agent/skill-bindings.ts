// The composer's `$` skill bindings (issue #308, ADR-0028), the Web twin of
// iOS's `SkillChips`. The draft stays a plain string with `$name` in it; a
// `$` menu pick also binds the range it inserted, and only bound names are
// sent as `skills` (the host expands those). A hand-typed `$name` is text.
//
// Every value change goes through `followEdit`: bindings clear of the edit
// shift with it, one the edit deleted or replaced is dropped, and one the
// edit cut into survives only where `$name` still reads intact in place. Ranges are UTF-16 offsets into the composer's value.
import { skillMentionRanges } from "@pinomad/client/skill-mentions.ts";

export interface SkillBinding {
  /** Offset of the `$`. */
  readonly start: number;
  /** Offset just after the name. */
  readonly end: number;
  readonly name: string;
}

export interface SkillDraft {
  /** The composer value the binding ranges belong to. */
  readonly text: string;
  /** Bindings in text order, each reading `$name`, never overlapping (`normalized`). */
  readonly bindings: readonly SkillBinding[];
}

export const emptyDraft: SkillDraft = { text: "", bindings: [] };

const reads = (text: string, start: number, name: string): boolean =>
  start >= 0 && text.startsWith(`$${name}`, start);

/**
 * The bindings invariant: sorted by start, each reading `$name` in `text`,
 * none overlapping another (the earlier one wins; an exact duplicate is
 * dropped). Following an edit can land two bindings on one range — delete
 * one of `$review $review ` and the diff can't tell which went — so every
 * result passes through here.
 */
function normalized(text: string, bindings: readonly SkillBinding[]): SkillBinding[] {
  const kept: SkillBinding[] = [];
  let end = 0;
  for (const binding of [...bindings].sort((a, b) => a.start - b.start)) {
    if (binding.start < end || !reads(text, binding.start, binding.name)) continue;
    kept.push(binding);
    end = binding.end;
  }
  return kept;
}

/**
 * `draft` moved onto `next`, one contiguous edit away from `draft.text`
 * (common prefix and suffix, as iOS's `SkillChips.following` diffs).
 * `picked` names the skill a `$` menu pick just inserted: the `$picked` that
 * touches the edit is bound.
 */
export function followEdit(draft: SkillDraft, next: string, picked?: string): SkillDraft {
  const old = draft.text;
  if (next === old && picked === undefined) return draft;
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldEditEnd = old.length - suffix;
  const delta = next.length - old.length;

  const bindings: SkillBinding[] = [];
  for (const binding of draft.bindings) {
    // Wholly before the edit it stays, wholly after it shifts. One the edit's
    // old span swallows was deleted or replaced: it is dropped, never moved
    // onto identical text outside the edit. When the same text sits beside
    // it the diff may name the wrong copy (delete a typed `$review` in front
    // of a picked one and the pick unbinds) — the accepted cost, since
    // under-sending beats sending a skill nobody picked. One the edit cuts
    // into survives only where `$name` still reads in place.
    let start: number | undefined;
    if (binding.end <= prefix) start = binding.start;
    else if (binding.start >= oldEditEnd) start = binding.start + delta;
    else if (binding.start < prefix || binding.end > oldEditEnd) start = binding.start;
    if (start !== undefined && reads(next, start, binding.name)) {
      bindings.push({ start, end: start + 1 + binding.name.length, name: binding.name });
    }
  }

  if (picked !== undefined) {
    const length = picked.length + 1;
    const nextEditEnd = next.length - suffix;
    // The last `$picked` overlapping or touching the edited span.
    let at = -1;
    for (let i = next.indexOf(`$${picked}`); i !== -1 && i <= nextEditEnd; i = next.indexOf(`$${picked}`, i + 1)) {
      if (i + length >= prefix) at = i;
    }
    if (at !== -1) {
      const pick: SkillBinding = { start: at, end: at + length, name: picked };
      const kept = bindings.filter((b) => b.end <= pick.start || b.start >= pick.end);
      return { text: next, bindings: normalized(next, [...kept, pick]) };
    }
  }
  return { text: next, bindings: normalized(next, bindings) };
}

/**
 * The draft a queued message's Edit gives back: its text with every lexical
 * `$name` mention of the skills it expanded bound again — the same mentions
 * its bubble highlights.
 */
export function restoreDraft(text: string, skills: readonly string[]): SkillDraft {
  if (skills.length === 0) return { text, bindings: [] };
  return {
    text,
    // Lexical matches never overlap: already normalized.
    bindings: skillMentionRanges(text, skills).map(({ start, end }) => ({ start, end, name: text.slice(start + 1, end) })),
  };
}

const WHITESPACE = /\p{White_Space}/u;
// What would stop the bubble's matcher from ending the mention at the name:
// its follow rule (a letter, number, `_` or `$`) plus `-`, which its
// `[a-z0-9-]+` name run swallows (`$review-now` reads as `review-now`). The
// leading side needs no such list — any non-whitespace before `$` gets a space.
const WORD_CHAR = /[\p{Alphabetic}\p{N}_$-]/u;

/**
 * What `submit` / `createConversation` send: the text with each bound `$name`
 * kept apart from glued text — a space before it unless whitespace already
 * is, and after it where the next character would continue the name — so the
 * bubble's lexical match finds it; and the bound names, deduplicated in text
 * order (`[]` with none).
 */
export function draftMessage(draft: SkillDraft): { text: string; skills: string[] } {
  const { text } = draft;
  const skills: string[] = [];
  let out = "";
  let at = 0;
  // Normalized again so a broken invariant can't duplicate or splice text.
  for (const binding of normalized(text, draft.bindings)) {
    out += text.slice(at, binding.start);
    if (out !== "" && !WHITESPACE.test(out.at(-1)!)) out += " ";
    out += text.slice(binding.start, binding.end);
    at = binding.end;
    if (at < text.length && WORD_CHAR.test(String.fromCodePoint(text.codePointAt(at)!))) out += " ";
    if (!skills.includes(binding.name)) skills.push(binding.name);
  }
  out += text.slice(at);
  return { text: out, skills };
}
