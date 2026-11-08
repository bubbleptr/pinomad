import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import {
  fakeProcesses,
  fakeRemote,
  fakeTerminals,
  fakeView,
  PARSER_ID,
  PROCESSES,
  SUBAGENT_ID,
  subagentConversation,
  TERMINALS,
} from "../../test/story-fixtures.tsx";
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

const processList = fakeProcesses({ lists: { [PARSER_ID]: PROCESSES } });
const withProcesses = fakeRemote(view, {}, processList);

/** Running processes first, then ended ones newest first; the tally counts the live one. */
export const Processes: Story = { args: { remote: withProcesses } };

const openProcess = (name: RegExp) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name }));
  await within(canvasElement).findByRole("button", { name: "Back to tasks" });
};

/** A running process's read-only screen, with its command and Stop. */
export const ProcessDetail: Story = {
  args: { remote: withProcesses },
  play: openProcess(/dev server/),
};

/** A process the previous host stopped tracking: no output, no Stop, its old pid. */
export const ProcessLost: Story = {
  args: { remote: withProcesses },
  play: openProcess(/sleep 300/),
};

/** Without `hello.processes` the historical list still shows; only Stop and output are gone. */
export const ProcessesUnavailable: Story = {
  args: {
    remote: fakeRemote(
      view,
      {},
      fakeProcesses({
        lists: { [PARSER_ID]: PROCESSES },
        unavailable: "The host couldn't load its process module; its log says which package is missing",
      }),
    ),
  },
};

/** The shown conversation's checkout diff, with branch and +N −M in the first row. */
export const Changes: Story = { args: { surface: "changes" } };

/** While drafting there is no family to list. */
export const Drafting: Story = { args: { shownId: undefined } };

/** On a phone the panel is a fullscreen dialog. */
export const Narrow: Story = { args: { narrow: true } };

/** The owner's terminals: one tab each, an exited one greyed with its code. */
export const Terminal: Story = {
  args: { surface: "terminal", remote: { ...fakeRemote(view), terminals: fakeTerminals({ lists: { [PARSER_ID]: TERMINALS } }) } },
};

/** No terminal yet: one button, nothing opened on its own. */
export const TerminalEmpty: Story = { args: { surface: "terminal" } };

/** A host without the pty module, or too old, says why instead. */
export const TerminalUnavailable: Story = {
  args: {
    surface: "terminal",
    remote: { ...fakeRemote(view), terminals: fakeTerminals({ unavailable: "The host is too old for terminals (needs protocol 5.27); run `pinomad upgrade` on the host" }) },
  },
};

/** On a phone the tabs take a second row under the surface switch. */
export const TerminalNarrow: Story = {
  args: { ...Terminal.args, narrow: true },
};
