// `$name` skill expansion (issue #308, ADR-0028): a user message that invokes
// a skill reaches the model with that skill's full text in front of it, the
// way pi-coding-agent expands `/skill:name`. A 5.16 client names the skills
// the user picked from the `$` menu; an older client's text is matched with
// the composer's lexical rule (`skillMentionRanges`) instead. Clients strip
// the blocks back off for display (`stripUserBlocks`).
import { readFile } from "node:fs/promises";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { withSkillBlocks, type SkillBlock } from "@pinomad/client/skill-blocks.ts";
import { skillMentionRanges } from "@pinomad/client/skill-mentions.ts";

/** A skill in scope: its name and where its file is. */
export interface SkillFile {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
}

/** A skill whose file could not be read; the text goes out without its block. */
export interface ExpansionFailure {
  readonly name: string;
  readonly filePath: string;
  readonly message: string;
}

/** The distinct skill names `text` mentions with `$name`, in first-mention order — the fallback for clients that bind none. */
export function mentionedSkillNames(text: string, names: readonly string[]): string[] {
  return [...new Set(skillMentionRanges(text, names).map((range) => text.slice(range.start + 1, range.end)))];
}

/**
 * `text` with one block per distinct name in `names`, in that order, ahead
 * of the text itself (kept verbatim). A name `skills` lacks is `missing`, a
 * file that cannot be read is a failure; neither gets a block. Nothing to
 * expand leaves `text` as it is.
 */
export async function expandSkills(
  text: string,
  names: readonly string[],
  skills: readonly SkillFile[],
): Promise<{ readonly text: string; readonly missing: readonly string[]; readonly failures: readonly ExpansionFailure[] }> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const blocks: SkillBlock[] = [];
  const missing: string[] = [];
  const failures: ExpansionFailure[] = [];
  for (const name of new Set(names)) {
    const skill = byName.get(name);
    if (skill === undefined) {
      missing.push(name);
      continue;
    }
    try {
      const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
      blocks.push({ name, location: skill.filePath, baseDir: skill.baseDir, body });
    } catch (error) {
      failures.push({ name, filePath: skill.filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { text: withSkillBlocks(blocks, text), missing, failures };
}
