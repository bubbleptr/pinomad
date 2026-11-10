// A unified-patch renderer (ADR-0005): each file's header and +N −M from
// @pinomad/client/patch.ts (shared with the native clients), its body
// syntax-highlighted by @pierre/diffs (highlighted-diff.tsx, loaded lazily),
// with plain green/red lines while that loads or when it can't place a file.
// Used for tool-result details and the side panel's Changes surface, which
// folds a long patch's files so opening it stays cheap.
import { parsePatch } from "@pinomad/client/patch.ts";
import { lazy, Suspense, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { ChevronRight } from "../shared/ui/icons.tsx";

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
  if (files.length === 0) return <Text type="supporting">No changes.</Text>;
  return (
    <VStack gap={2}>
      {files.map((file, index) => {
        const open = chosen.get(file.path) ?? !folded;
        const heading = (
          <>
            <Text type="supporting" weight="semibold" maxLines={1}>
              {file.oldPath !== undefined && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
            </Text>
            {file.isNew ? <Token label="new" color="green" size="sm" /> : null}
            {file.isDeleted ? <Token label="deleted" color="red" size="sm" /> : null}
            <Text type="supporting">
              +{file.additions} −{file.deletions}
            </Text>
          </>
        );
        return (
          <VStack key={`${file.path}-${index}`} gap={0}>
            {collapsible ? (
              <FileToggle
                open={open}
                onToggle={() => setChosen((current) => new Map(current).set(file.path, !open))}
              >
                {heading}
              </FileToggle>
            ) : (
              <HStack gap={2} vAlign="center" padding={1}>
                {heading}
              </HStack>
            )}
            {!open ? null : file.binary === true ? (
              <Text type="supporting">Binary file</Text>
            ) : file.lines.length === 0 ? null : (
              <Suspense fallback={<PlainLines lines={file.lines} />}>
                <HighlightedFile patch={patch} path={file.path} fallback={<PlainLines lines={file.lines} />} />
              </Suspense>
            )}
          </VStack>
        );
      })}
    </VStack>
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
