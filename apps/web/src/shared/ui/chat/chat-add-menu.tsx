// The composer's + menu (issue #254): one flat list of entries — images, and
// one per typed trigger (`$` skill, `@` agent, `/` command), each opening the
// same menu typing the trigger would.
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Plus } from "@/shared/ui/icons";

/** The ghost `+` button and its menu; children are `ChatAddMenuItem`s. */
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
      menuWidth={288}
      onOpenChange={onOpenChange}
      // Up, like the model popover: below a draft's composer the menu runs
      // off short screens; the layer still flips when there's no room.
      placement="above"
    >
      {children}
    </DropdownMenu>
  );
}

/**
 * One + menu row on a single line: icon, label, and a muted hint at the end —
 * the other way in (`Or type $`), or why the row is disabled.
 */
export function ChatAddMenuItem({
  icon: Icon,
  label,
  hint,
  isDisabled,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  hint?: string;
  isDisabled?: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem
      icon={<Icon aria-hidden="true" className="size-4 text-muted" />}
      label={
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="shrink-0">{label}</span>
          {hint === undefined ? null : <span className="ml-auto min-w-0 truncate text-xs text-muted">{hint}</span>}
        </span>
      }
      isDisabled={isDisabled}
      onClick={onClick}
    />
  );
}
