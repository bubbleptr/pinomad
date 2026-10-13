// Named agents (ADR-0023): one `<name>.md` per agent in the host's data dir.
// The host's loader, its calls and client-side editors share this validation;
// the file layer adds loader concerns (unknown fields, unparsable frontmatter)
// on top. Hermes-safe: no Buffer, no Node APIs.
import { THINKING_LEVELS, isThinkingLevel } from "./settings.ts";
import type { ThinkingLevel } from "./view.ts";

export interface AgentRole {
  /** The file name without `.md`; also what `subagent`'s `role` arg takes. */
  readonly name: string;
  readonly description: string;
  /** `provider/modelId`; pinned when set — a `subagent` call may not override it. */
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** The Markdown body, trimmed; may be "". */
  readonly prompt: string;
}

export interface AgentRoleProblem {
  /** The file's basename, e.g. `Reviewer.md`. */
  readonly file: string;
  readonly reason: string;
}

export interface AgentRoles {
  readonly roles: readonly AgentRole[];
  readonly problems: readonly AgentRoleProblem[];
}

export const MAX_AGENT_NAME = 32;
export const MAX_AGENT_DESCRIPTION = 1024;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why a role can't be saved or loaded, or undefined when it can. Shared by the
 * host loader, the gateway's calls, and client pre-checks — the same two-layer
 * split as `imageProblem` (shape on the wire, content here).
 */
export function agentRoleProblem(role: {
  name: string;
  description: string;
  model?: string;
  thinkingLevel?: string;
  prompt: string;
}): string | undefined {
  if (role.name.length > MAX_AGENT_NAME || !NAME_PATTERN.test(role.name)) {
    return `Name must be lowercase letters, digits and hyphens (max ${MAX_AGENT_NAME})`;
  }
  const description = role.description.trim();
  if (description === "") return "description is required";
  if (description.length > MAX_AGENT_DESCRIPTION) return `description is too long (max ${MAX_AGENT_DESCRIPTION})`;
  if (role.model !== undefined) {
    const slash = role.model.indexOf("/");
    if (slash <= 0 || slash === role.model.length - 1) return "model must be provider/modelId";
  }
  if (role.thinkingLevel !== undefined && !isThinkingLevel(role.thinkingLevel)) {
    return `thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`;
  }
  return undefined;
}
