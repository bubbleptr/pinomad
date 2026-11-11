import { SideNav } from "@astryxdesign/core/SideNav";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  devboxView,
  fakeHosts,
  fakeMachines,
  fakeView,
  BACKGROUND_SUBAGENT_ID,
  DEVBOX_HOST,
  FORK_ID,
  HOME_HOST,
  NAS_HOST,
  NESTED_FORK_ID,
  PARSER_ID,
  signedIn,
  SECOND_FORK_ID,
  withAccount,
  withBackgroundSubagents,
  withDesktopUpdates,
  withForks,
  withHosts,
} from "../../test/story-fixtures.tsx";
import { SidebarContent, SidebarFooter, SidebarHeaderBand } from "./sidebar.tsx";

// The SideNav AppFrame mounts these into, minus its resizable width.
function SidebarFrame(args: Parameters<typeof SidebarContent>[0]) {
  return (
    <div className="h-[calc(100vh-3rem)] w-[260px]">
      <SideNav
        header={<SidebarHeaderBand onCollapse={fn()} />}
        footer={<SidebarFooter onOpenSettings={fn()} onOpenAccount={fn()} onLocateHost={fn()} />}
      >
        <SidebarContent {...args} />
      </SideNav>
    </div>
  );
}

const meta = {
  title: "Widgets/AppFrame/Sidebar",
  component: SidebarContent,
  decorators: [withHosts(fakeHosts([HOME_HOST, DEVBOX_HOST, NAS_HOST])), withAccount(signedIn())],
  parameters: { canvasWidth: "full" },
  args: {
    machines: fakeMachines(),
    focusKey: HOME_HOST.hostKey,
    draftingChat: false,
    shownId: PARSER_ID,
    onDraft: fn(),
    onNewChat: fn(),
    onOpen: fn(),
    onShowMachine: fn(),
  },
  render: (args) => <SidebarFrame {...args} />,
} satisfies Meta<typeof SidebarContent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every paired machine gets a group; the NAS has not connected yet. */
export const Default: Story = {};

/** A single pairing still gets its machine header. */
export const SingleMachine: Story = {
  decorators: [withHosts(fakeHosts([HOME_HOST]))],
  args: { machines: fakeMachines().slice(0, 1) },
};

export const DraftingChat: Story = { args: { draftingChat: true, shownId: undefined } };

/** The desktop app marks Settings once an update is downloaded. */
export const UpdateReady: Story = {
  decorators: [withDesktopUpdates({ state: "ready", currentVersion: "0.9.0", availableVersion: "0.10.0" })],
};

/** Without an account, the user chip shows the device's own name. */
export const NoAccount: Story = { decorators: [withAccount({ status: "unavailable" })] };

/** A long account email is cut off with an ellipsis instead of overflowing the sidebar. */
export const LongAccountEmail: Story = {
  decorators: [withAccount(signedIn({ user: "first.middle.lastname.with.a.long.alias@example-company.example" }))],
};

/** A machine that dropped keeps its last list, greyed and read-only. */
export const OfflineMachine: Story = {
  args: { machines: fakeMachines({ devbox: devboxView({ connection: "reconnecting" }) }) },
};

/** Unpaired from omarchy: its last projects drop out, leaving one row that opens the explanation. */
export const RejectedMachine: Story = {
  args: {
    machines: fakeMachines({ devbox: devboxView({ connection: "closed", unauthorized: true }) }).map((machine) =>
      machine.label === "omarchy" ? { ...machine, rejected: true } : machine,
    ),
  },
};

export const Empty: Story = {
  args: {
    machines: fakeMachines({ home: fakeView({ organized: { chats: [], projects: [], archived: [] } }) }).slice(0, 1),
    shownId: undefined,
  },
};

const forkMachines = () => fakeMachines({ home: withForks(fakeView()) });

/** A fork is an independent row after its root, in the same project group. */
export const ForkRows: Story = { args: { machines: forkMachines(), shownId: PARSER_ID } };

/** Selecting a fork deselects its root; the two rows never compete. */
export const ForkSelected: Story = { args: { machines: forkMachines(), shownId: FORK_ID } };

/** Legacy fork-of-a-fork data keeps every fork navigable, depth-first. */
export const LegacyNestedForks: Story = {
  args: { machines: forkMachines(), shownId: NESTED_FORK_ID },
};

/** The second root-level fork still follows the first one's legacy descendant. */
export const SecondForkSelected: Story = {
  args: { machines: forkMachines(), shownId: SECOND_FORK_ID },
};

/** Subagents get no rows (ADR-0047 §1): the root stays selected while one of its subagents is shown in main. */
export const SubagentShown: Story = {
  args: { machines: fakeMachines({ home: withBackgroundSubagents(fakeView()) }), shownId: BACKGROUND_SUBAGENT_ID },
};
