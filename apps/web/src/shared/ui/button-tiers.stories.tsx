import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "./item.tsx";
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
          <Button variant="secondary">Cancel</Button>
          <Button variant="primary">Save</Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Settings rows: secondary, sm</span>
        <ItemGroup>
          <Item render={<li />}>
            <ItemContent>
              <ItemTitle>MacBook Pro</ItemTitle>
              <ItemDescription>Paired Oct 12</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="secondary" size="sm">Connection</Button>
              <Button variant="secondary" size="sm">Unpair</Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Confirming an irreversible action: destructive + secondary</span>
        <div className="flex gap-2">
          <Button variant="destructive">Delete account</Button>
          <Button variant="secondary">Cancel</Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">Chrome and flow switches: ghost</span>
        <div className="flex items-center gap-2">
          <IconButton label="Back" icon={<ArrowLeft />} variant="ghost" size="sm" />
          <IconButton label="More" icon={<MoreHorizontal />} variant="ghost" size="sm" />
          <Button variant="ghost">Sign in instead</Button>
        </div>
      </div>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex gap-2">
      <Button variant="primary" disabled>Primary</Button>
      <Button variant="secondary" disabled>Secondary</Button>
      <Button variant="ghost" disabled>Ghost</Button>
      <Button variant="destructive" disabled>Destructive</Button>
    </div>
  ),
};

// Loading keeps the label's width under the spinner; a disabled button with a
// tooltip stays focusable.
export const States: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" loading>Save</Button>
      <Button variant="secondary" loading>Refresh</Button>
      <Button variant="destructive" size="sm" loading>Delete account</Button>
      <IconButton label="Refresh" icon={<ArrowLeft />} loading />
      <Button variant="secondary" disabled tooltip="Connect the host first">Unpair</Button>
    </div>
  ),
};
