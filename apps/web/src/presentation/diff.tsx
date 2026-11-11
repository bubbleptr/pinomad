// A unified-patch renderer (ADR-0005): each file's header and +N −M from
// @pinomad/client/patch.ts (shared with the native clients), its body
// syntax-highlighted by @pierre/diffs (highlighted-diff.tsx, loaded lazily),
// with plain green/red lines while that loads or when it can't place a file.
// Used for tool-result details and the side panel's Changes surface, which
// folds a long patch's files so opening it stays cheap.
import { parsePatch } from "@pinomad/client/patch.ts";
import { lazy, Suspense, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight } from "../shared/ui/icons.tsx";
import { Badge } from "../shared/ui/badge.tsx";

// Suspense doesn't catch a chunk that fails to load; without this, a network
// blip on first use would unmount the page instead of leaving the plain lines.
const HighlightedFile = lazy(() =>
  import("./highlighted-diff.tsx").catch(() => ({ default: ({ fallback }: { fallback: ReactNode }) => fallback })),
);

const fileStyle: CSSProperties = {
  fontFamily: "var(--font-family-code)",
  fontSize: "var(--font-size-sm)",
  lineHeight: "var(--line-height-sm, 1.5)",
  overflowX: "auto",
  whiteSpace: "pre",
  borderRadius: "var(--radius-sm, 6px)",
};

const kindStyles: Record<string, CSSProperties> = {
  add: { backgroundColor: "var(--color-success-muted)", color: "var(--color-text-primary)" },
  del: { backgroundColor: "var(--color-error-muted)", color: "var(--color-text-primary)" },
  ctx: { color: "var(--color-text-secondary)" },
  meta: { color: "var(--color-text-accent)", backgroundColor: "var(--color-background-muted)" },
};

/** Above this many diff lines, a collapsible view starts with every file folded. */
const FOLD_LINES = 400;

export function DiffView({ patch, collapsible = false }: { patch: string; collapsible?: boolean }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const folded = collapsible && files.reduce((sum, file) => sum + file.lines.length, 0) > FOLD_LINES;
  // What the reader chose per path; files they never touched follow the threshold.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  if (files.length === 0) return <span className="text-xs/5 text-muted-foreground">No changes.</span>;
  return (
    <div className="flex flex-col gap-2">
      {files.map((file, index) => {
        const open = chosen.get(file.path) ?? !folded;
        const title = file.oldPath !== undefined && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
        const heading = (
          <>
            <span className="block truncate text-xs/5 font-semibold text-muted-foreground" title={title}>
              {title}
            </span>
            {file.isNew ? <Badge variant="success">new</Badge> : null}
            {file.isDeleted ? <Badge variant="destructive">deleted</Badge> : null}
            <span className="text-xs/5 text-muted-foreground">
              +{file.additions} −{file.deletions}
            </span>
          </>
        );
        return (
          <div className="flex flex-col" key={`${file.path}-${index}`}>
            {collapsible ? (
              <FileToggle
                open={open}
                onToggle={() => setChosen((current) => new Map(current).set(file.path, !open))}
              >
                {heading}
              </FileToggle>
            ) : (
              <div className="flex items-center gap-2 p-1">
                {heading}
              </div>
            )}
            {!open ? null : file.binary === true ? (
              <span className="text-xs/5 text-muted-foreground">Binary file</span>
            ) : file.lines.length === 0 ? null : (
              <Suspense fallback={<PlainLines lines={file.lines} />}>
                <HighlightedFile patch={patch} path={file.path} fallback={<PlainLines lines={file.lines} />} />
              </Suspense>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A file's lines without highlighting. */
function PlainLines({ lines }: { lines: ReturnType<typeof parsePatch>[number]["lines"] }) {
  return (
    <div style={fileStyle}>
      {lines.map((line, lineIndex) => (
        <div key={lineIndex} style={kindStyles[line.kind]}>
          {line.text}
        </div>
      ))}
    </div>
  );
}

/** A file's header as the button that folds its lines. */
function FileToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      className="flex min-w-0 items-center gap-2 rounded-[var(--radius-sm,6px)] p-1 text-left hover:bg-[var(--color-overlay-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-border-emphasized)]"
      onClick={onToggle}
    >
      <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-90" : ""}`} aria-hidden="true" />
      {children}
    </button>
  );
}
