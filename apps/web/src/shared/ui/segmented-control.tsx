import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "cn";
import type { ReactElement } from "react";

// One choice out of a few, always one picked. A radio group underneath, not a
// toggle group: it can't be emptied, arrow keys move the pick, and assistive
// tech hears "radio, 1 of 3". Flat in both themes: a recessed track and the
// picked segment one step lighter than anything under it, with the buttons'
// hairline. Sized for settings rows (28px).

type SegmentedControlProps = Omit<RadioGroupPrimitive.Props<string>, "className" | "onValueChange"> & {
  className?: string;
  onValueChange: (value: string) => void;
};

function SegmentedControl({ className, onValueChange, ...props }: SegmentedControlProps): ReactElement {
  return (
    <RadioGroupPrimitive<string>
      data-slot="segmented-control"
      className={cn(
        "inline-flex h-7 w-fit items-center gap-0.5 rounded-lg bg-[light-dark(oklch(0_0_0/5%),oklch(0_0_0/22%))] p-0.5 data-disabled:opacity-50",
        className,
      )}
      onValueChange={(value) => onValueChange(value)}
      {...props}
    />
  );
}

function SegmentedControlItem({
  className,
  ...props
}: Omit<RadioPrimitive.Root.Props<string>, "className"> & { className?: string }): ReactElement {
  return (
    <RadioPrimitive.Root<string>
      data-slot="segmented-control-item"
      className={cn(
        "inline-flex h-full cursor-pointer items-center justify-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none",
        "not-data-[disabled]:hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:cursor-not-allowed",
        "data-checked:bg-[light-dark(#ffffff,oklch(0.335_0_0))] data-checked:text-foreground data-checked:shadow-[inset_0_0_0_1px_light-dark(oklch(0_0_0/8%),oklch(1_0_0/6%))]",
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
