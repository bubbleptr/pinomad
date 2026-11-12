import { Card } from "./card.tsx";
import type { ReactNode } from "react";

/**
 * Rows of one kind on a Settings page: an optional title over a bordered box,
 * a divider between rows. Give it an `ItemGroup` or a `ul` with GROUP_ROWS.
 * The danger tone colors the title for irreversible actions.
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
    <div className="flex flex-col gap-2" style={{ width: "100%" }}>
      {title === undefined ? null : tone === "danger" ? (
        <h4 className="text-sm/5 font-bold" style={{ color: "var(--destructive-strong)" }}>
          {title}
        </h4>
      ) : (
        <h4 className="text-sm/5 font-bold">{title}</h4>
      )}
      <Card className="gap-0 py-0">
        {children}
      </Card>
    </div>
  );
}

/** The rows of a SettingsGroup, a divider between each: put it on the `ItemGroup` or `ul`. */
export const GROUP_ROWS = "m-0 flex list-none flex-col gap-0 p-0 divide-y divide-[var(--border)] *:rounded-none";

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
        <span className="text-sm/5">{label}</span>
        {description === undefined ? null : <span className="text-xs/5 text-muted-foreground">{description}</span>}
      </div>
      {/* Never wider than the row, so the controls wrap instead of being clipped. */}
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
