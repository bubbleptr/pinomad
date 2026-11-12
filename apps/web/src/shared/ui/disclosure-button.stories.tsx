import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId, useState } from "react";
import { DisclosureButton, DisclosureChevron } from "./disclosure-button";

const meta = {
  title: "Shared/DisclosureButton",
  component: DisclosureButton,
  args: { open: true },
} satisfies Meta<typeof DisclosureButton>;

export default meta;
type Story = StoryObj<typeof meta>;

function Section({ leading }: { leading: boolean }) {
  const [open, setOpen] = useState(true);
  const region = useId();
  return (
    <div className="flex flex-col gap-1">
      <DisclosureButton
        open={open}
        aria-controls={region}
        className="flex items-center gap-2 rounded-md p-1 text-start text-xs font-medium text-muted-foreground hover:bg-surface-hover"
        onClick={() => setOpen(!open)}
      >
        {leading ? <DisclosureChevron /> : null}
        <span className="flex-1">Workspace</span>
        {leading ? null : <DisclosureChevron />}
      </DisclosureButton>
      <p id={region} hidden={!open} className="px-1 text-sm">
        The region the button folds.
      </p>
    </div>
  );
}

/** The chevron leads, as on a diff's file header. */
export const ChevronFirst: Story = { render: () => <Section leading /> };

/** The chevron trails, as on the overview card's sections. */
export const ChevronLast: Story = { render: () => <Section leading={false} /> };
