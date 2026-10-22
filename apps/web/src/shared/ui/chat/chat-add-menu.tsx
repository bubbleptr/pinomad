// The composer's + menu (issue #254): one entry for everything that can go
// into a message or the conversation it starts. Compound DropdownMenu rather
// than `items` because the draft's project and checkout pickers are
// single-choice rows (menuitemradio), which the data-driven mode can't express.
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuSubMenu } from "@astryxdesign/core/DropdownMenu";
import { Plus } from "@/shared/ui/icons";

/** The ghost `+` button and its menu; children are sections. */
export function ChatAddMenu({ isDisabled = false, children }: { isDisabled?: boolean; children: ReactNode }) {
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
      // Up, like the model popover: below a draft's composer the menu runs
      // off short screens; the layer still flips when there's no room.
      placement="above"
    >
      {children}
    </DropdownMenu>
  );
}

/** Same look as Astryx's data-mode section title; the group carries the name. */
function SectionTitle({ children }: { children: string }) {
  return (
    <div aria-hidden="true" className="select-none px-2 py-1 text-xs text-muted">
      {children}
    </div>
  );
}

/** A titled group of action rows (`DropdownMenuItem`s). */
export function ChatAddMenuSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div aria-label={title} role="group">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </div>
  );
}

/**
 * A single choice as one row — `label` over the current `valueLabel` — whose
 * flyout holds the options (`DropdownMenuRadioItem`s). A flyout, not inline
 * radios: the menu caps at 300px, and a project list grows with the host.
 */
export function ChatAddMenuChoice({
  label,
  value,
  valueLabel,
  onChange,
  children,
}: {
  label: string;
  value: string;
  valueLabel: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuSubMenu description={valueLabel} label={label}>
      <DropdownMenuRadioGroup label={label} value={value} onChange={onChange}>
        {children}
      </DropdownMenuRadioGroup>
    </DropdownMenuSubMenu>
  );
}
