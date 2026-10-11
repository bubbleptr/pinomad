import { toolTarget } from "@pinomad/protocol/tool-target.ts";

/**
 * Lifecycle of a tool invocation as rendered in the trace. Mirrors the state
 * union the runtime event pipeline produces (own type, not a vendor import).
 */
export type ToolPartState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

/**
 * One tool call in a transcript, as data. The DOM-free shape every client
 * renders from; a client that renders a custom pane (web's `detail` node)
 * extends it rather than the other way around.
 */
export type ToolItem = {
  argsText?: string;
  /** Nested Tool Executions this call started, in start order. */
  children?: ToolItem[];
  /** Per-edit line counts; rendered as additions/deletions stats. */
  diffStat?: { additions: number; deletions: number };
  durationMs?: number;
  /** Image blocks of the tool result, rendered after the output pane. */
  images?: readonly { data: string; mimeType: string }[];
  output?: string;
  state: ToolPartState;
  toolCallId?: string;
  toolName?: string;
};

/**
 * Display name for a tool call: `mcp__<server>__<tool>` reads as
 * `<server>/<tool>`, matching how Pi's TUI titles MCP calls. Anything else is
 * returned unchanged. Data layers keep the raw name; this is render-only.
 */
export function toolDisplayName(name: string | undefined): string | undefined {
  if (!name?.startsWith("mcp__")) {
    return name;
  }

  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");

  return separator === -1
    ? rest
    : `${rest.slice(0, separator)}/${rest.slice(separator + 2)}`;
}

/** Argument keys that name what a tool acted on, most specific first. */
export function toolTargetFromArgs(argsText: string | undefined): string | undefined {
  if (!argsText) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    return undefined;
  }
  return toolTarget(args);
}

export function formatToolDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }

  return durationMs < 1000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Visual class of a tool call, for the Codex-style kind icon on a CoT row.
 * The name is the model's; we only map the well-known Pi builtins and fall
 * back to a generic wrench rather than inventing a glyph per plugin.
 */
export type ToolKind = "shell" | "search" | "web" | "file" | "edit" | "tool";

const KIND_ALIASES: Record<string, ToolKind> = {
  bash: "shell",
  shell: "shell",
  sh: "shell",
  terminal: "shell",
  cmd: "shell",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
  search: "search",
  web_search: "web",
  websearch: "web",
  webfetch: "web",
  web_fetch: "web",
  web: "web",
  browser: "web",
  read: "file",
  read_file: "file",
  cat: "file",
  edit: "edit",
  write: "edit",
  write_file: "edit",
  str_replace: "edit",
};

export function normalizeToolName(name: string | undefined) {
  return (name ?? "").trim().toLowerCase().replace(/-/g, "_");
}

export function toolKindFromName(name: string | undefined): ToolKind {
  return KIND_ALIASES[normalizeToolName(name)] ?? "tool";
}

/** A burst of mixed kinds shares the generic wrench, matching Codex's header. */
export function toolKindFromTools(tools: ToolItem[]): ToolKind {
  const kinds = new Set(tools.map((tool) => toolKindFromName(tool.toolName)));

  if (kinds.size === 1) {
    return [...kinds][0];
  }

  return "tool";
}
