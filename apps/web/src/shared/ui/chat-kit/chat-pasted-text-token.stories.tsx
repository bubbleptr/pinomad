import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ChatPastedTextToken } from "./chat-pasted-text-token";

const meta = {
  title: "Shared/ChatKit/ChatPastedTextToken",
  component: ChatPastedTextToken,
  args: { text: "first line\nsecond line\nthird line", onExpand: fn() },
  // Room above the chip for the preview card it opens on hover.
  decorators: [(Story) => <div className="pt-72"><Story /></div>],
} satisfies Meta<typeof ChatPastedTextToken>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Hover the chip: the preview card holds the Expand button. */
export const Default: Story = {};
