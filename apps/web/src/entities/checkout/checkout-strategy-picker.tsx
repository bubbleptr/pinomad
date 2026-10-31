// Ported from Pace's entities/checkout/checkout-strategy-picker.tsx (PiGUI
// commit 15b9084): the draft's worktree/project-folder picker.
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { FolderGitTwo } from "@/shared/ui/icons";

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
    // The label stays "worktree" either way: the pressed background is the
    // selected state, and unpressed means the project folder itself.
    <div className="inline-flex max-w-full shrink-0" data-testid="checkout-strategy-picker">
      <ToggleButton
        icon={<FolderGitTwo aria-hidden="true" className="size-4 shrink-0 text-muted" />}
        isDisabled={isDisabled}
        isPressed={value === "worktree"}
        label="worktree"
        size="sm"
        tooltip="Use a Git worktree; when off, work in the project folder."
        onPressedChange={(isPressed) => onChange(isPressed ? "worktree" : "local")}
      />
    </div>
  );
}
