import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { contextUsage } from "@pinomad/client/context-usage.ts";
import {
  busyConversation,
  fakeProcesses,
  fakeRemote,
  fakeView,
  FINISHED_SUBAGENTS,
  MIXED_SUBAGENTS,
  PARSER_ID,
  PROCESSES,
  withSubagents,
} from "../../test/story-fixtures.tsx";
import { OverviewCard } from "./overview-card.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/Overview/OverviewCard",
  component: OverviewCard,
  decorators: [
    // The card floats over the chat column's top-right corner.
    (Story) => (
      <div className="relative h-[calc(100vh-3rem)]">
        <Story />
      </div>
    ),
  ],
  args: {
    view,
    remote: fakeRemote(view),
    conversation: view.conversation!,
    narrow: false,
    busy: false,
    onOpenChanges: fn(),
    onOpenTasks: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof OverviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Project: Story = {};

export const Busy: Story = { args: { conversation: busyConversation(), busy: true } };

/** Not a git checkout: the Changes row hides, the branch stays when the host sends one. */
export const NoChanges: Story = {
  args: { remote: fakeRemote(view, { changes: async () => ({ available: false, reason: "Not in a git repository" }) }) },
};

const chat = fakeView({ home: { kind: "chat" }, checkout: undefined });
export const Chat: Story = { args: { view: chat, remote: fakeRemote(chat) } };

export const Narrow: Story = { args: { narrow: true } };

const used = contextUsage(view.conversation!, 1)!.used;
const broken = {
  ...view,
  docs: [
    ...view.docs,
    {
      kind: "context.breakdown",
      presentation: "pinomad.context" as const,
      value: { used, system: 6_200, skills: 2_400, tools: 9_800, mcp: 4_100, messages: used - 22_500 },
    },
  ],
};
/** The host's breakdown of the reply the meter counts, under the Context row. */
export const ContextBreakdown: Story = { args: { view: broken, remote: fakeRemote(broken) } };

const problems = {
  ...view,
  mcp: {
    ...view.mcp!,
    errors: ["mcp.json: servers.notion.command must be a string, got a number on line 14"],
  },
};
/** Why a source failed is written out under it, not hidden behind a hover. */
export const SourceProblems: Story = { args: { view: problems, remote: fakeRemote(problems) } };

const mixed = withSubagents(view, MIXED_SUBAGENTS);
/** Subagents at work by name, then running processes; the rest counted in the line into Tasks. */
export const Tasks: Story = {
  args: { view: mixed, remote: fakeRemote(mixed, {}, fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } })) },
};

const finished = withSubagents(view, FINISHED_SUBAGENTS);
const ended = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES.filter((process) => process.state !== "running") } });
/** Nothing at work: the latest subagents to finish, failures first; ended processes stay in Tasks. */
export const TasksFinished: Story = { args: { view: finished, remote: fakeRemote(finished, {}, ended) } };
