import { IconButton } from "@astryxdesign/core/IconButton";
import type { Meta, StoryObj } from "@storybook/react-vite";
import * as AnimatedIcons from "./animated-icons.tsx";

// The gesture plays on a mouse visit to the enclosing control, so each icon
// sits in a real IconButton: hover one to run it. `isAnimated={false}` keeps
// the same glyph still.
const meta = {
  title: "Shared/AnimatedIcons",
  render: () => (
    <div className="grid w-fit grid-cols-[auto_repeat(3,140px)] items-center gap-x-2 gap-y-3 text-xs text-muted">
      <span />
      {Object.keys(AnimatedIcons).map((name) => (
        <span key={name} className="text-center">{name}</span>
      ))}
      {[true, false].map((isAnimated) => (
        <div key={String(isAnimated)} className="contents">
          <span>{isAnimated ? "Animated" : "Static"}</span>
          {Object.entries(AnimatedIcons).map(([name, Icon]) => (
            <div key={name} className="flex justify-center">
              <IconButton icon={<Icon className="size-4" isAnimated={isAnimated} />} label={name} variant="ghost" />
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
