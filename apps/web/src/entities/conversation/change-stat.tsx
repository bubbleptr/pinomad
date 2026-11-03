// The checkout's change figure (+N −M) and branch, shared by the overview's
// Workspace rows and the side panel's Changes bar so both read the same.
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { CallMethods } from "@pinomad/protocol/frames.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { parsePatch } from "@pinomad/client/patch.ts";

export type ChangesResult = CallMethods["changes"]["result"];

export type ChangeStat =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly branch?: string }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly files: number;
      readonly additions: number;
      readonly deletions: number;
      readonly truncated: boolean;
      readonly branch?: string;
    };

/** A `changes` answer summed into files and added/removed lines. */
export function changeStatOf(result: ChangesResult): ChangeStat {
  if (!result.available) return { kind: "unavailable", branch: result.branch };
  const files = parsePatch(result.patch);
  return {
    kind: "ready",
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: result.truncated,
    branch: result.branch,
  };
}

/**
 * The checkout's branch. A 5.11 host reports HEAD's branch with changes() —
 * live, so a worktree that went detached shows nothing instead of the
 * recorded name. Older hosts only know the checkout record's branch.
 */
export function branchOf(view: DurableView, stat: ChangeStat): string | undefined {
  const minor = view.host?.protocol.minor;
  if (minor !== undefined && hostSupportsFeature(minor, "liveBranch")) {
    return stat.kind === "ready" || stat.kind === "unavailable" ? stat.branch : undefined;
  }
  return view.checkout?.branch;
}

const count = (value: number): string => value.toLocaleString("en-US");

/** The checkout's +N −M, or why there isn't one yet. */
export function ChangeFigure({ stat }: { stat: Exclude<ChangeStat, { kind: "unavailable" }> }) {
  return stat.kind === "loading" ? (
    <span className="text-muted">…</span>
  ) : stat.kind === "failed" ? (
    <span className="text-muted">—</span>
  ) : stat.files === 0 ? (
    <span className="text-muted">None</span>
  ) : stat.additions === 0 && stat.deletions === 0 ? (
    // Binary edits, renames and mode changes touch files without text lines.
    <span className="text-muted">
      {stat.files} file{stat.files === 1 ? "" : "s"}
    </span>
  ) : (
    // A truncated patch undercounts: "+" marks the numbers as a floor.
    <span aria-label={`${count(stat.additions)} added, ${count(stat.deletions)} removed${stat.truncated ? " at least" : ""}`}>
      <span className="text-success">+{count(stat.additions)}{stat.truncated ? "+" : ""}</span>{" "}
      <span className="text-danger">−{count(stat.deletions)}{stat.truncated ? "+" : ""}</span>
    </span>
  );
}
