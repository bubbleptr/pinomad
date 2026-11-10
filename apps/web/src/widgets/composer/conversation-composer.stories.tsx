import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { busyConversation, fakeRemote, fakeView, subagentConversation } from "../../test/story-fixtures.tsx";
import { ConversationComposer } from "./conversation-composer.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/Composer/ConversationComposer",
  component: ConversationComposer,
  decorators: [
    // It sits at the foot of the chat column.
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] flex-col justify-end">
        <Story />
      </div>
    ),
  ],
  args: { view, remote: fakeRemote(view), conversation: view.conversation!, busy: false, narrow: false },
} satisfies Meta<typeof ConversationComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

/** Running, with a steer and a follow-up queued behind the run. */
export const BusyWithQueue: Story = { args: { conversation: busyConversation(), busy: true } };

export const Disconnected: Story = {
  args: { view: fakeView({ connection: "reconnecting" }) },
};

export const Narrow: Story = { args: { narrow: true } };

/** The + menu: one row per way into the message, each with its typed shortcut. */
export const AddMenu: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "More actions" }));
  },
};

/** A conversation created with a named agent: `@tester` leads the model capsule, read-only. */
export const WithRole: Story = { args: { conversation: subagentConversation() } };

/** A leading `/` opens the host's commands. */
export const CommandMenu: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("combobox", { name: "Prompt" }));
    await userEvent.keyboard("/");
  },
};

/** A `$` opens the skills, each on one line with its description. */
export const SkillMenu: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("combobox", { name: "Prompt" }));
    await userEvent.keyboard("$");
  },
};

/** A pre-5.15 host lists no commands: the + menu keeps Compact conversation. */
const olderHost = fakeView({ host: { version: "0.8.0", protocol: { major: 5, minor: 14 } } });
export const OlderHostAddMenu: Story = {
  args: { view: olderHost, remote: fakeRemote(olderHost), conversation: olderHost.conversation! },
  play: AddMenu.play,
};

/** A command the host lists as temporarily unavailable shows greyed with its reason. */
export const CommandMenuWithDisabled: Story = {
  args: {
    remote: fakeRemote(view, {
      listCommands: async () => ({
        commands: [
          { name: "compact", description: "Summarize older context to free up space", argumentHint: "[instructions]", source: "builtin" },
          { name: "handoff", description: "Write a handoff for a fresh conversation", source: "plugin", disabled: "Not while a run is in flight" },
        ],
      }),
    }),
  },
  play: CommandMenu.play,
};
