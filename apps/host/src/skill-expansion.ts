// `$name` skill expansion (issue #308, ADR-0028): a user message that
// mentions a skill reaches the model with that skill's full text in front of
// it, the way pi-coding-agent expands `/skill:name`. Mentions follow the
// composer's own lexical rule (`skillMentionRanges`), so what the input
// highlights is what expands. Clients strip the blocks back off for display
// (`stripSkillBlocks`).
import { readFile } from "node:fs/promises";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { withSkillBlocks, type SkillBlock } from "@pinomad/client/skill-blocks.ts";
import { skillMentionRanges } from "@pinomad/client/skill-mentions.ts";

/** A skill the text may mention: its name and where its file is. */
export interface SkillFile {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
}

/** A mentioned skill whose file could not be read; the text goes out without its block. */
export interface ExpansionFailure {
  readonly name: string;
  readonly filePath: string;
  readonly message: string;
}

/**
 * `text` with one block per distinct mentioned skill, in first-mention order,
 * ahead of the text itself (kept verbatim, `$name` tokens included). No
 * mention, or no readable skill among them, leaves `text` as it is.
 */
export async function expandSkillMentions(
  text: string,
  skills: readonly SkillFile[],
): Promise<{ readonly text: string; readonly failures: readonly ExpansionFailure[] }> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const mentioned = new Set(skillMentionRanges(text, [...byName.keys()]).map((range) => text.slice(range.start + 1, range.end)));
  const blocks: SkillBlock[] = [];
  const failures: ExpansionFailure[] = [];
  for (const name of mentioned) {
    const skill = byName.get(name)!;
    try {
      const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
      blocks.push({ name, location: skill.filePath, baseDir: skill.baseDir, body });
    } catch (error) {
      failures.push({ name, filePath: skill.filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { text: withSkillBlocks(blocks, text), failures };
}
