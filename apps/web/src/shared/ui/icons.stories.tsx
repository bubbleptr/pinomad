import type { Meta, StoryObj } from "@storybook/react-vite";
import * as Icons from "./icons.tsx";

const meta = {
  title: "Shared/Icons",
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2">
      {Object.entries(Icons).map(([name, Icon]) => (
        <div key={name} className="flex flex-col items-center gap-2 rounded-lg border border-border px-2 py-3">
          <Icon size={24} />
          <span className="text-xs text-muted">{name}</span>
        </div>
      ))}
    </div>
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
