import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ToolKind } from "@pinomad/client/tool-item.ts";
import { ChatToolKindIcon } from "./chat-tool-kind.tsx";

const meta = {
  title: "Shared/Chat/ChatToolKindIcon",
  component: ChatToolKindIcon,
  args: { kind: "shell" },
} satisfies Meta<typeof ChatToolKindIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Shell: Story = {};

const kinds: ToolKind[] = ["shell", "search", "web", "file", "edit", "tool"];

export const AllKinds: Story = {
  render: () => (
    <ul style={{ display: "grid", gap: 8, listStyle: "none", margin: 0, padding: 0 }}>
      {kinds.map((kind) => (
        <li key={kind} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ChatToolKindIcon kind={kind} />
          <span>{kind}</span>
        </li>
      ))}
    </ul>
  ),
};
