// Ported from Pace's entities/checkout/checkout-strategy-picker.tsx (PiGUI
// commit 15b9084): the draft's worktree/project-folder picker.
import { Checkbox } from "../../shared/ui/checkbox.tsx";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Tooltip } from "@astryxdesign/core/Tooltip";

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
    // The label stays "worktree" either way: the checkmark is the selected
    // state, and unchecked means the project folder itself.
    <div className="inline-flex max-w-full shrink-0" data-testid="checkout-strategy-picker">
      <Tooltip content="Use a Git worktree; when off, work in the project folder." isEnabled={!isDisabled}>
        <Field orientation="horizontal" disabled={isDisabled} className="w-auto gap-2">
          <Checkbox
            checked={value === "worktree"}
            onCheckedChange={(checked) => onChange(checked ? "worktree" : "local")}
          />
          <FieldLabel className="font-normal">worktree</FieldLabel>
        </Field>
      </Tooltip>
    </div>
  );
}
