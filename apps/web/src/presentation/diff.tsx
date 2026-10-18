// A unified-patch renderer (ADR-0005): show the parsed files, hunks, and
// lines with theme colors — green added, red removed, subdued hunk markers.
// Used for tool-result details and the conversation Changes panel. The
// parser itself lives in @pinomad/client/patch.ts (shared with the native
// clients).
import { parsePatch } from "@pinomad/client/patch.ts";
import { useMemo, type CSSProperties } from "react";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";

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
