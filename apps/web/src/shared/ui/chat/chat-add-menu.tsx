// The composer's + menu (issue #254): one flat list of entries — images, and
// one per typed trigger (`$` skill, `@` agent, `/` command), each opening the
// same menu typing the trigger would.
import type { ReactNode } from "react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Plus } from "@/shared/ui/icons";

/** The ghost `+` button and its menu; children are `DropdownMenuItem`s. */
export function ChatAddMenu({
  isDisabled = false,
  onOpenChange,
  children,
}: {
  isDisabled?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu
      button={{
        label: "More actions",
        variant: "ghost",
        size: "sm",
        isIconOnly: true,
        icon: <Plus aria-hidden="true" />,
        isDisabled,
      }}
      hasChevron={false}
      menuWidth={240}
      onOpenChange={onOpenChange}
      // Up, like the model popover: below a draft's composer the menu runs
      // off short screens; the layer still flips when there's no room.
      placement="above"
    >
      {children}
    </DropdownMenu>
  );
}
