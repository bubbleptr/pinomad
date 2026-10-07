// A unified-patch renderer (ADR-0005): parse `diff --git` output into files,
// hunks, and lines, and show them with theme colors — green added, red
// removed, subdued hunk markers. Used for tool-result details and the
// conversation Changes panel.
import { useMemo, type CSSProperties } from "react";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";

export interface ParsedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  readonly binary?: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: readonly { readonly kind: "add" | "del" | "ctx" | "meta"; readonly text: string }[];
}

type FileInProgress = {
  path: string;
  oldPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  lines: { kind: "add" | "del" | "ctx" | "meta"; text: string }[];
};

const stripPrefix = (line: string, marker: string, prefix: string): string =>
  line.startsWith(`${marker} ${prefix}`) ? line.slice(marker.length + 1 + prefix.length) : line.slice(marker.length + 1);

/**
 * Parse unified diff output — `git diff` (`diff --git` headers) and the `diff`
 * package's `createPatch` shape (`Index:`/`---`/`+++` without git headers).
 * Inside a hunk every line is body: the `@@ -a,b +c,d @@` counts decide when it
 * ends, so a removed `-- comment` or added `+++ x` line can't masquerade as a
 * file header. Header and extended lines (`index`, `* mode`, `Index:`,
 * `====`, similarity, binary payloads) are structure, not rendered content.
 */
export function parsePatch(patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let file: FileInProgress | undefined;
  // Lines the current hunk still owes, for old and new sides. While either is
  // positive, every line belongs to the hunk regardless of its prefix.
  let remainingOld = 0;
  let remainingNew = 0;
  // A file opened by `diff --git` still expects its own `---` header line.
  let needsOldHeader = false;
  const fresh = (path: string): FileInProgress => ({ path, isNew: false, isDeleted: false, binary: false, additions: 0, deletions: 0, lines: [] });
  const push = (): void => {
    if (file === undefined) return;
    // A deleted file carries no `+++` name — fall back to the old one.
    if (file.path === "" && file.oldPath !== undefined) file.path = file.oldPath;
    files.push(file);
  };

  for (const line of patch.split("\n")) {
    if ((remainingOld > 0 || remainingNew > 0) && file !== undefined) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" consumes nothing on either side.
        file.lines.push({ kind: "ctx", text: line });
      } else if (line.startsWith("+")) {
        file.additions += 1;
        file.lines.push({ kind: "add", text: line });
        remainingNew -= 1;
      } else if (line.startsWith("-")) {
        file.deletions += 1;
        file.lines.push({ kind: "del", text: line });
        remainingOld -= 1;
      } else {
        // " ctx" and empty lines count against both sides.
        file.lines.push({ kind: "ctx", text: line });
        remainingOld -= 1;
        remainingNew -= 1;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (file !== undefined && hunk !== null) {
        remainingOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
        remainingNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
        file.lines.push({ kind: "meta", text: line });
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      push();
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      file = fresh(match?.[2] ?? line.slice(11));
      needsOldHeader = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (file !== undefined && needsOldHeader) {
        // The current `diff --git` file's own `---` header, not a new file.
        needsOldHeader = false;
        if (line === "--- /dev/null") file.isNew = true;
        else file.oldPath = stripPrefix(line, "---", "a/");
      } else {
        push();
        file = fresh("");
        if (line === "--- /dev/null") file.isNew = true;
        else file.oldPath = stripPrefix(line, "---", "a/");
      }
      continue;
    }
    if (file === undefined) continue;
    if (line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") file.isDeleted = true;
      else file.path = stripPrefix(line, "+++", "b/");
    } else if (line.startsWith("new file mode")) file.isNew = true;
    else if (line.startsWith("deleted file mode")) file.isDeleted = true;
    else if (line.startsWith("rename from ")) file.oldPath = line.slice(12);
    else if (line.startsWith("rename to ")) file.path = line.slice(10);
    else if (line.startsWith("copy from ")) file.oldPath = line.slice(10);
    else if (line.startsWith("copy to ")) file.path = line.slice(8);
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.binary = true;
    // Any other header/extended line (index, modes, Index:, ====, similarity,
    // binary payload) is structure — skipped rather than rendered as content.
  }
  push();
  return files;
}

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

export function DiffView({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  if (files.length === 0) return <Text type="supporting">No changes.</Text>;
  return (
    <VStack gap={2}>
      {files.map((file, index) => (
        <VStack key={`${file.path}-${index}`} gap={0}>
          <HStack gap={2} vAlign="center" padding={1}>
            <Text type="supporting" weight="semibold" maxLines={1}>
              {file.oldPath !== undefined && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
            </Text>
            {file.isNew ? <Token label="new" color="green" size="sm" /> : null}
            {file.isDeleted ? <Token label="deleted" color="red" size="sm" /> : null}
            <Text type="supporting">
              +{file.additions} −{file.deletions}
            </Text>
          </HStack>
          {file.binary === true ? (
            <Text type="supporting">Binary file</Text>
          ) : file.lines.length === 0 ? null : (
            <div style={fileStyle}>
              {file.lines.map((line, lineIndex) => (
                <div key={lineIndex} style={kindStyles[line.kind]}>
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </VStack>
      ))}
    </VStack>
  );
}
