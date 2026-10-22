import { Button } from "@astryxdesign/core/Button";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ChatInlinePager } from "./chat-inline-pager.tsx";
import { TextShimmer } from "./text-shimmer.tsx";

const meta = {
  title: "Shared/Chat/ChatInlinePager",
  component: ChatInlinePager,
  args: { pageKey: "settled", children: "Thought 2s" },
} satisfies Meta<typeof ChatInlinePager>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {};

const pages = [
  { key: "c1", label: "Running read…" },
  { key: "c2", label: "Running bash…" },
  { key: "c3", label: "Running edit…" },
  { key: "settled", label: "Ran 1 command, read 1 file, edited 1 file" },
];

// Each click turns one page; clicks inside the dwell window collapse into one flip.
export const FlipOnClick: Story = {
  render: function Render(args) {
    const [index, setIndex] = useState(0);
    const page = pages[index % pages.length]!;
    return (
      <div style={{ display: "grid", gap: 12, justifyItems: "start" }}>
        <ChatInlinePager {...args} pageKey={page.key}>
          {page.key === "settled" ? page.label : <TextShimmer>{page.label}</TextShimmer>}
        </ChatInlinePager>
        <Button label="Next page" size="sm" variant="secondary" onClick={() => setIndex((each) => each + 1)} />
      </div>
    );
  },
};
