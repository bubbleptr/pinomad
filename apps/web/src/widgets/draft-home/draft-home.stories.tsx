import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { fakeRemote, fakeView, PINOMAD } from "../../test/story-fixtures.tsx";
import { DraftHome } from "./draft-home.tsx";

// A draft has no shown conversation yet.
const view = fakeView({ conversation: undefined, home: undefined, checkout: undefined, docs: [] });

const meta = {
  title: "Widgets/DraftHome/DraftHome",
  component: DraftHome,
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] flex-col">
        <Story />
      </div>
    ),
  ],
  parameters: { canvasWidth: "full" },
  args: {
    view,
    remote: fakeRemote(view),
    draft: { kind: "project", path: PINOMAD.path },
    onDraft: fn(),
    onCreated: fn(),
    connected: true,
  },
} satisfies Meta<typeof DraftHome>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Project: Story = {};

export const Chat: Story = { args: { draft: { kind: "chat" } } };

export const Disconnected: Story = { args: { connected: false } };

/** A host without models can't start anything. */
const noModels = fakeView({ conversation: undefined, models: [], defaults: {}, settings: null });
export const NoModels: Story = { args: { view: noModels, remote: fakeRemote(noModels) } };
