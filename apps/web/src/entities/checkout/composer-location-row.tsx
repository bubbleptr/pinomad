// Ported from Pace's entities/checkout/composer-location-row.tsx and
// checkout-strategy-picker.tsx (PiGUI commit 15b9084): the static chip,
// the location row, and the draft's worktree/project-folder picker.
import type { ReactNode } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { ChevronDown, Computer, FolderLibrary, type FolderClosed } from "@/shared/ui/icons";

/**
 * A Location or Branch that can no longer be chosen — a conversation's
 * checkout — wearing the chrome of the picker it stands in for, so the row
 * does not change type size or metrics when a control becomes a label.
 */
export function ComposerStaticChip({
  chrome,
  icon: Icon,
  label,
  testId,
}: {
  chrome: "selector" | "button";
  icon: typeof FolderClosed;
  label: string;
  testId?: string;
}) {
  const selectorChrome = chrome === "selector";
  return (
    <span
      className={`inline-flex h-7 min-w-0 max-w-[16rem] items-center text-sm font-medium ${
        selectorChrome ? "gap-2 px-3 text-foreground" : "gap-1.5 px-2 text-muted"
      }`}
      data-testid={testId}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="truncate">{label}</span>
      {selectorChrome ? (
        <ChevronDown aria-hidden="true" className="invisible size-4 shrink-0" />
      ) : null}
    </span>
  );
}

/** The composer's location row: where the conversation runs, which branch it is on. */
export function ComposerLocationRow({
  location,
  branch,
  meter,
}: {
  location?: ReactNode;
  branch?: ReactNode;
  /** Right-aligned slot; empty for now — no context meter yet. */
  meter?: ReactNode;
}) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {location}
      {branch}
      <span className="ml-auto inline-flex shrink-0">{meter}</span>
    </span>
  );
}

export type CheckoutMode = "worktree" | "local";

/** Pace's CheckoutStrategyPicker: a project draft chooses worktree vs project dir. */
export function CheckoutStrategyPicker({
  value,
  onChange,
  isDisabled = false,
}: {
  value: CheckoutMode;
  onChange: (mode: CheckoutMode) => void;
  isDisabled?: boolean;
}) {
  return (
    <div className="max-w-full" data-testid="checkout-strategy-picker">
      <Selector
        isLabelHidden
        label="Where to work"
        placement="below"
        isDisabled={isDisabled}
        options={[
          {
            value: "worktree",
            label: "Git worktree",
            icon: <FolderLibrary aria-hidden="true" className="size-4 shrink-0 text-muted" />,
          },
          {
            value: "local",
            label: "Project folder",
            icon: <Computer aria-hidden="true" className="size-4 shrink-0 text-muted" />,
          },
        ]}
        size="sm"
        startIcon={
          value === "worktree"
            ? <FolderLibrary aria-hidden="true" className="size-4 shrink-0 text-muted" />
            : <Computer aria-hidden="true" className="size-4 shrink-0 text-muted" />
        }
        value={value}
        variant="ghost"
        onChange={(picked) => onChange(picked === "worktree" ? "worktree" : "local")}
      />
    </div>
  );
}
