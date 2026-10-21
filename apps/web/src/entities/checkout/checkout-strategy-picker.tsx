// Ported from Pace's entities/checkout/checkout-strategy-picker.tsx (PiGUI
// commit 15b9084): the draft's worktree/project-folder picker.
import { Selector } from "@astryxdesign/core/Selector";
import { Computer, FolderLibrary } from "@/shared/ui/icons";

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
