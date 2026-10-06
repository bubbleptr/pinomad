import { dirname, join, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, section, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import type { BuiltinExtension } from "../builtin-extension.ts";

const PREAMBLE =
  "You are PiNomad, a coding agent running on the user's own machine. You work in the project directory below with the read, write, edit, and bash tools: read files before changing them, prefer edit over rewriting whole files, and run commands to check your work. Keep answers short and concrete. When it is unclear what the user wants, ask instead of guessing.";

/** What the context extension renders about a worktree checkout (ADR-0010 §8/§9). */
export interface ContextCheckout {
  readonly branch: string;
  /** Commit the branch started at. */
  readonly base: string;
  /** The user's original project directory — off-limits for edits. */
  readonly projectPath: string;
  /** Repository top level. */
  readonly repo: string;
  /** The worktree's own root directory. */
  readonly worktreeRoot: string;
}

export interface ContextOptions {
  readonly agentsHome: string;
  /**
   * Resolves the conversation's worktree checkout from committed docs; the
   * composition root wires it to the host's index (extension boundary).
   */
  readonly checkout?: (
    input: { readonly conversationId: ConversationId; readonly read: DocumentReader },
    context: Context,
  ) => Promise<ContextCheckout | undefined>;
}

/**
 * System prompt sections rendered from the filesystem at every request, so edits to
 * AGENTS.md or skill files take effect without a restart. PiNomad reads only its own
 * agent home (ADR-0001: no ~/.pi config compatibility beyond model auth).
 */
export function createContext(options: ContextOptions): BuiltinExtension {
  const { agentsHome } = options;
  const resolveCheckout = (input: { conversationId: ConversationId; read: DocumentReader }, context: Context) =>
    options.checkout?.(input, context);
  return {
    extension: defineExtension({
      name: "context",
      sections: [
        section("preamble", () => PREAMBLE, { tag: false }),
        section("environment", async (input, context) => {
          const cwd = input.agent.cwd;
          if (cwd === undefined) return undefined;
          const checkout = await resolveCheckout({ conversationId: input.conversationId, read: input.read }, context);
          if (checkout === undefined) return `Working directory: ${cwd}`;
          return [
            `Working directory: ${cwd}`,
            `This directory is a git worktree PiNomad created for this conversation, on branch ${checkout.branch} starting from commit ${checkout.base.slice(0, 12)}.`,
            `The user's project directory is ${checkout.projectPath} and must not be modified.`,
            "This is a fresh checkout: ignored files (dependencies such as node_modules, or .env) are absent — install dependencies per AGENTS.md when needed.",
          ].join("\n");
        }),
        section("project_context", async (input, context) => {
          const cwd = input.agent.cwd;
          if (cwd === undefined) return undefined;
          const checkout = await resolveCheckout({ conversationId: input.conversationId, read: input.read }, context);
          let files: { path: string; content: string }[];
          if (checkout === undefined) {
            files = loadProjectContextFiles({ cwd, agentDir: agentsHome });
          } else {
            // The worktree sits outside the project's tree: ancestors of the
            // repo load at the project's location, the repo's own files load
            // from their copies inside the worktree — the same set the agent
            // would see working in the project dir directly.
            const seen = new Set<string>();
            files = [
              ...loadProjectContextFiles({ cwd: dirname(checkout.repo), agentDir: agentsHome }),
              ...loadProjectContextFiles({ cwd, agentDir: agentsHome }).filter((file) =>
                file.path.startsWith(checkout.worktreeRoot + sep),
              ),
            ].filter((file) => {
              if (seen.has(file.path)) return false;
              seen.add(file.path);
              return true;
            });
          }
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
