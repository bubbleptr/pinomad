// One short "what is this tool working on" string for a tool call's
// arguments — the card's subtitle. Shared by the host (summary `activity`)
// and the web client (tool rows, subagent cards). Hermes-safe: pure TS.

const TARGET_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "name",
  // PiNomad: subagent calls label their card with the short description, then the task.
  "description",
  "task",
] as const;

const TARGET_MAX_LENGTH = 120;

/** The first recognized target-ish argument value, truncated; undefined when none. */
export function toolTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  for (const key of TARGET_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > TARGET_MAX_LENGTH ? `${value.slice(0, TARGET_MAX_LENGTH)}…` : value;
    }
  }
  return undefined;
}
