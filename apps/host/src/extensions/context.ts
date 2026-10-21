import { dirname, join, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, section, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { formatSkillsForPrompt, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { BuiltinExtension } from "../builtin-extension.ts";
import { scopedSkills } from "../skills.ts";

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
  /** False when the record belongs to another conversation sharing this cwd — a fork or a subagent. */
  readonly own: boolean;
}

/** What the resolver knows beyond the checkout record: whether this conversation is a fork. */
export interface ContextResolution {
  readonly checkout?: ContextCheckout;
  readonly fork: boolean;
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
  ) => Promise<ContextResolution | undefined>;
}

// The fixed `$`-mention rules (issue #143): always rendered, next to the
// skills they reference — the model resolves `$name` against the prompt's
// skills list, reads the file itself, and never gets a name expanded or a
// match invented from elsewhere.
const SKILL_MENTION_RULES =
  "In a user message, `$name` outside code blocks, inline code, and quoted text refers to one of the skills listed above — the user is explicitly asking you to use that skill: read its file with the read tool before doing anything else. A `$name` inside code or quotations is not a request, and neither is one the user is only discussing or telling you not to use. Resolve names only against the skills listed above; do not go looking for same-named files elsewhere. If reading a skill's file fails, tell the user instead of guessing what the skill would have said.";

// ADR-0019: a fork shares its parent's working directory; isolation is the
// agent's choice, made explicit here because nothing else enforces it.
const FORK_SHARED_DIR =
  "This conversation is a fork: it shares this working directory with the conversation it was forked from, which may be editing the same files. If your task needs isolation, create your own git worktree (for example `git worktree add <dir> -b <branch>`) and use absolute paths inside it for every read, write, edit and bash command.";

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
          const resolved = await resolveCheckout({ conversationId: input.conversationId, read: input.read }, context);
          const checkout = resolved?.checkout;
          // The fork line covers every checkout kind — a fork that still owns a
          // pre-ADR-0019 worktree record renders like a plain conversation.
          const forkLine = resolved?.fork === true && checkout?.own !== true ? [FORK_SHARED_DIR] : [];
          if (checkout === undefined) {
            return [`Working directory: ${cwd}`, ...forkLine].join("\n");
          }
          return [
            `Working directory: ${cwd}`,
            checkout.own
              ? `This directory is a git worktree PiNomad created for this conversation, on branch ${checkout.branch} starting from commit ${checkout.base.slice(0, 12)}.`
              : `This directory is a git worktree PiNomad created for the conversation this one belongs to, on branch ${checkout.branch} starting from commit ${checkout.base.slice(0, 12)}.`,
            `The user's project directory is ${checkout.projectPath} and must not be modified.`,
            "This is a fresh checkout: ignored files (dependencies such as node_modules, or .env) are absent — install dependencies per AGENTS.md when needed.",
            ...forkLine,
          ].join("\n");
        }),
        // Fixed convention (issue #138): unconditional, named agents or not —
        // `@./path` is only a path; nothing injects file contents.
        section("file_references", () => "When the user writes @./path in their message, it is a project file the user references; the path is relative to your current working directory. Its contents are not expanded for you — read the file yourself if the task needs them.", { tag: false }),
        section("project_context", async (input, context) => {
          const cwd = input.agent.cwd;
          if (cwd === undefined) return undefined;
          const checkout = (await resolveCheckout({ conversationId: input.conversationId, read: input.read }, context))?.checkout;
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
            // The same loader listSkills uses (issue #143): project entry
            // first — on a name collision the project's skill wins.
            const skills = scopedSkills(cwd, agentsHome).map((scoped) => scoped.skill);
            const text = formatSkillsForPrompt(skills, "read");
            return [text, SKILL_MENTION_RULES].filter((part) => part !== "").join("\n");
          },
          { tag: false },
        ),
      ],
    }),
  };
}
