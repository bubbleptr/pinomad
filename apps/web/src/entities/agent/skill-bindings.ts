// The composer's `$` skill bindings (issue #308, ADR-0028), the Web twin of
// iOS's `SkillChips`. The draft stays a plain string with `$name` in it; a
// `$` menu pick also binds the range it inserted, and only bound names are
// sent as `skills` (the host expands those). A hand-typed `$name` is text.
//
// Every value change goes through `followEdit`: bindings clear of the edit
// shift with it, and one the edit cut into survives only where `$name` still
// reads intact. Ranges are UTF-16 offsets into the composer's value.
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
  /** Bindings in text order, never overlapping. */
  readonly bindings: readonly SkillBinding[];
}

export const emptyDraft: SkillDraft = { text: "", bindings: [] };

const reads = (text: string, start: number, name: string): boolean =>
  start >= 0 && text.startsWith(`$${name}`, start);

/**
 * `draft` moved onto `next`, one contiguous edit away from `draft.text`
 * (common prefix and suffix, as iOS diffs). `picked` names the skill a `$`
 * menu pick just inserted: the `$picked` that touches the edit is bound.
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
    // An insert right at an edge diffs ambiguously, so a touched binding may
    // read intact either where it was or shifted by the edit.
    const candidates =
      binding.end <= prefix
        ? [binding.start]
        : binding.start >= oldEditEnd
          ? [binding.start + delta]
          : [binding.start, binding.start + delta];
    const start = candidates.find((at) => reads(next, at, binding.name));
    if (start !== undefined) bindings.push({ start, end: start + 1 + binding.name.length, name: binding.name });
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
      kept.push(pick);
      kept.sort((a, b) => a.start - b.start);
      return { text: next, bindings: kept };
    }
  }
  return { text: next, bindings };
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
    bindings: skillMentionRanges(text, skills).map(({ start, end }) => ({ start, end, name: text.slice(start + 1, end) })),
  };
}

const WHITESPACE = /\p{White_Space}/u;
// What continues a mention past the name — skillMentionRanges' follow rule.
const WORD_CHAR = /[\p{Alphabetic}\p{N}_$]/u;

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
  for (const binding of draft.bindings) {
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
