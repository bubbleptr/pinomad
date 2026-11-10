import { Card } from "@astryxdesign/core/Card";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/**
 * Rows of one kind on a Settings page: an optional title over a bordered box,
 * a divider between rows. Give it a `List hasDividers`, or a `ul` with
 * GROUP_ROWS. The danger tone colors the title for irreversible actions.
 */
export function SettingsGroup({
  title,
  tone = "default",
  children,
}: {
  title?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <VStack gap={2} style={{ width: "100%" }}>
      {title === undefined ? null : tone === "danger" ? (
        <Heading level={4} color="inherit" style={{ color: "var(--color-error)" }}>
          {title}
        </Heading>
      ) : (
        <Heading level={4}>{title}</Heading>
      )}
      <Card padding={0} style={{ overflow: "hidden" }}>
        {children}
      </Card>
    </VStack>
  );
}

/** A hand-built row list inside a SettingsGroup: the dividers `List hasDividers` draws. */
export const GROUP_ROWS = "m-0 flex list-none flex-col p-0 divide-y divide-[var(--color-border)]";

/**
 * One setting in a SettingsGroup: what it is on the left, its control on the
 * right. The control names itself (its own label); the row's label is what
 * the reader scans. Narrow, the control wraps under the text.
 */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
        <Text>{label}</Text>
        {description === undefined ? null : <Text type="supporting">{description}</Text>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
