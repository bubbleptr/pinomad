import { Field as FieldPrimitive } from "@base-ui/react/field";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ComponentProps, ReactElement, ReactNode } from "react";

// Base UI's Field wires the parts together: the label's `for`, and the
// description and error into the control's aria-describedby, so a call site
// only nests them. `invalid` on Field sets aria-invalid on the control.

const fieldVariants = cva("group/field flex w-full gap-1.5", {
  variants: {
    orientation: {
      vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
      horizontal:
        "flex-row items-center gap-2 has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-0.5",
    },
  },
  defaultVariants: { orientation: "vertical" },
});

type FieldProps = Omit<FieldPrimitive.Root.Props, "className"> &
  VariantProps<typeof fieldVariants> & { className?: string };

function Field({ className, orientation = "vertical", ...props }: FieldProps): ReactElement {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

/** The label and description of a checkbox or switch beside it. */
function FieldContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="field-content" className={cn("flex flex-1 flex-col gap-0.5", className)} {...props} />;
}

function FieldLabel({ className, ...props }: Omit<FieldPrimitive.Label.Props, "className"> & { className?: string }): ReactElement {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm/5 font-medium select-none group-data-[disabled]/field:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Linked to the control as its description. Renders nothing without children. */
function FieldDescription({
  className,
  children,
  ...props
}: Omit<FieldPrimitive.Description.Props, "className"> & { className?: string }): ReactElement | null {
  if (isEmpty(children)) return null;
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn("text-xs/5 font-normal text-muted-foreground text-pretty", className)}
      {...props}
    >
      {children}
    </FieldPrimitive.Description>
  );
}

/** The field's error, announced when it appears. Renders nothing without children. */
function FieldError({
  className,
  children,
  ...props
}: Omit<FieldPrimitive.Error.Props, "className" | "match"> & { className?: string }): ReactElement | null {
  if (isEmpty(children)) return null;
  return (
    <FieldPrimitive.Error
      match
      role="alert"
      data-slot="field-error"
      className={cn("text-xs/5 font-normal text-destructive", className)}
      {...props}
    >
      {children}
    </FieldPrimitive.Error>
  );
}

const isEmpty = (children: ReactNode): boolean =>
  children === undefined || children === null || children === false || children === "";

export { Field, FieldContent, FieldDescription, FieldError, FieldLabel };
