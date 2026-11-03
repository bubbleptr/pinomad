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
    surface: "tasks",
    busy: false,
    liveActivity: false,
    onOpenChange: fn(),
    onSelectSurface: fn(),
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

/** The detail keeps its header and back button while the snapshot loads. */
const loadingSubagent = fakeView({ side: { id: SUBAGENT_ID, docs: [] } });
export const TaskDetailLoading: Story = { args: { view: loadingSubagent, remote: fakeRemote(loadingSubagent) } };

/** The shown conversation's checkout diff, with branch and +N −M in the first row. */
export const Changes: Story = { args: { surface: "changes" } };

/** While drafting there is no family to list. */
export const Drafting: Story = { args: { shownId: undefined } };

/** On a phone the panel is a fullscreen dialog. */
export const Narrow: Story = { args: { narrow: true } };
