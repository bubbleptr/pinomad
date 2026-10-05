import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import type { BuiltinExtension } from "../builtin-extension.ts";

const PREAMBLE =
  "You are PiNomad, a coding agent running on the user's own machine. You work in the project directory below with the read, write, edit, and bash tools: read files before changing them, prefer edit over rewriting whole files, and run commands to check your work. Keep answers short and concrete. When it is unclear what the user wants, ask instead of guessing.";

/**
 * System prompt sections rendered from the filesystem at every request, so edits to
 * AGENTS.md or skill files take effect without a restart. PiNomad reads only its own
 * agent home (ADR-0001: no ~/.pi config compatibility beyond model auth).
 */
export function createContext(options: { agentsHome: string }): BuiltinExtension {
  const { agentsHome } = options;
  return {
    extension: defineExtension({
      name: "context",
      sections: [
        section("preamble", () => PREAMBLE, { tag: false }),
        section("environment", (input) =>
          input.agent.cwd === undefined ? undefined : `Working directory: ${input.agent.cwd}`,
        ),
        section("project_context", (input) => {
          const cwd = input.agent.cwd;
          if (cwd === undefined) return undefined;
          const files = loadProjectContextFiles({ cwd, agentDir: agentsHome });
          return files.length === 0
            ? undefined
            : files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
        }),
        section(
          "skills",
          (input) => {
            const cwd = input.agent.cwd;
            if (cwd === undefined) return undefined;
            // Project skills first: on a name collision the earlier path wins.
            const { skills } = loadSkills({
              cwd,
              agentDir: agentsHome,
              includeDefaults: false,
              skillPaths: [join(cwd, ".agents", "skills"), join(agentsHome, "skills")],
            });
            const text = formatSkillsForPrompt(skills, "read");
            return text === "" ? undefined : text;
          },
          { tag: false },
        ),
      ],
    }),
  };
}
