import type { ReactElement, ReactNode } from "react";
import { Button, type ButtonProps } from "@/shared/ui/button";

type IconButtonProps = Omit<ButtonProps, "children" | "size" | "aria-label"> & {
  /** The accessible name. Shown only through `tooltip`, if one is passed. */
  label: string;
  icon: ReactNode;
  size?: "md" | "sm";
};

/** A button that is only an icon. Ghost unless told otherwise (apps/web/DESIGN.md). */
function IconButton({ label, icon, variant = "ghost", size = "md", ...props }: IconButtonProps): ReactElement {
  return (
    <Button aria-label={label} variant={variant} size={size === "sm" ? "icon-sm" : "icon"} {...props}>
      {icon}
    </Button>
  );
}

export { IconButton, type IconButtonProps };
