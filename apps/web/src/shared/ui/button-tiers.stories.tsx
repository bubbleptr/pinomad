import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeft, MoreHorizontal } from "./icons.tsx";

// The four tiers from apps/web/DESIGN.md, each in the place it belongs.
const meta = {
  title: "Shared/ButtonTiers",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const InContext: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Dialog footer: primary + secondary</span>
        <div className="flex justify-end gap-2">
          <Button label="Cancel" variant="secondary" />
          <Button label="Save" variant="primary" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Settings rows: secondary, sm</span>
        <List>
          <ListItem
            label="MacBook Pro"
            description="Paired Oct 12"
            endContent={
              <div className="flex gap-2">
                <Button label="Connection" variant="secondary" size="sm" />
                <Button label="Unpair" variant="secondary" size="sm" />
              </div>
            }
          />
        </List>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Confirming an irreversible action: destructive + secondary</span>
        <div className="flex gap-2">
          <Button label="Delete account" variant="destructive" />
          <Button label="Cancel" variant="secondary" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Chrome and flow switches: ghost</span>
        <div className="flex items-center gap-2">
          <IconButton label="Back" icon={<ArrowLeft />} variant="ghost" size="sm" />
          <IconButton label="More" icon={<MoreHorizontal />} variant="ghost" size="sm" />
          <Button label="Sign in instead" variant="ghost" />
        </div>
      </div>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex gap-2">
      <Button label="Primary" variant="primary" isDisabled />
      <Button label="Secondary" variant="secondary" isDisabled />
      <Button label="Ghost" variant="ghost" isDisabled />
      <Button label="Destructive" variant="destructive" isDisabled />
    </div>
  ),
};
