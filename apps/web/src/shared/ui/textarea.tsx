import { Field as FieldPrimitive } from "@base-ui/react/field"
import * as React from "react"
import { cn } from "cn"

// Field.Control rendered as a <textarea>, so a Field's label and description
// attach to it the way they do to Input.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <FieldPrimitive.Control
      render={<textarea />}
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...(props as FieldPrimitive.Control.Props)}
    />
  )
}

export { Textarea }
