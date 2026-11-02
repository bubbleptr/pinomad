import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { fakeRemote, fakeView, PARSER_ID, SUBAGENT_ID, subagentConversation } from "../../test/story-fixtures.tsx";
import { SidePanel } from "./side-panel.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/SidePanel/SidePanel",
  component: SidePanel,
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: { canvasWidth: "full" },
  args: {
    view,
    remote: fakeRemote(view),
    shownId: PARSER_ID,
    narrow: false,
    open: true,
    onOpenChange: fn(),
    openInPanel: fn(),
    onOpenInMain: fn(),
  },
} satisfies Meta<typeof SidePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Foreground work, grouped by its owner. */
export const Tasks: Story = {};

/** A running subagent's transcript, read-only. */
const withSubagent = fakeView({ side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } });
export const TaskDetail: Story = { args: { view: withSubagent, remote: fakeRemote(withSubagent) } };

/** While drafting there is no family to list. */
export const Drafting: Story = { args: { shownId: undefined } };

/** On a phone the panel is a fullscreen dialog. */
export const Narrow: Story = { args: { narrow: true } };
