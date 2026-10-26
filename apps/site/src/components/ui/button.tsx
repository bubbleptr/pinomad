import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils.ts";

// From the shadcn CLI (base-vega), restyled to the landing page's buttons: a white
// pill, a quiet outlined pill, and the small outlined copy button. Focus keeps the
// page's own :focus-visible outline. Links styled as buttons use buttonVariants()
// on a plain <a>.
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center border font-semibold no-underline disabled:cursor-default",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground transition-[background-color,border-color] duration-150 ease-[ease] hover:bg-[oklch(0.86_0_0)] active:bg-[oklch(0.8_0_0)] disabled:bg-secondary disabled:text-muted-foreground",
        quiet:
          "border-input bg-transparent text-foreground transition-[background-color,border-color] duration-150 ease-[ease] hover:border-muted-foreground hover:bg-muted active:bg-accent",
        outline: "border-input bg-transparent text-foreground hover:bg-accent",
      },
      size: {
        default: "min-h-[2.875rem] gap-2 rounded-full px-5 py-[0.65rem] text-[0.95rem]",
        sm: "min-h-10 gap-2 rounded-full px-4 py-2 text-[0.9rem]",
        xs: "min-h-8 rounded-[0.5rem] px-3 py-[0.3rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
