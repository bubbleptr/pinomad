import { SideNav } from "@astryxdesign/core/SideNav";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  devboxView,
  fakeHosts,
  fakeMachines,
  fakeView,
  DEVBOX_HOST,
  HOME_HOST,
  NAS_HOST,
  PARSER_ID,
  signedIn,
  withAccount,
  withDesktopUpdates,
  withHosts,
} from "../../test/story-fixtures.tsx";
import { SidebarContent, SidebarFooter, SidebarHeaderBand } from "./sidebar.tsx";

// The SideNav AppFrame mounts these into, minus its resizable width.
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
  render: (args) => (
    <div className="h-[calc(100vh-3rem)] w-[260px]">
      <SideNav
        header={<SidebarHeaderBand onCollapse={fn()} />}
        footer={<SidebarFooter onOpenSettings={fn()} onOpenAccount={fn()} onLocateHost={fn()} />}
      >
        <SidebarContent {...args} />
      </SideNav>
    </div>
  ),
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

/** A machine that dropped keeps its last list, greyed and read-only. */
export const OfflineMachine: Story = {
  args: { machines: fakeMachines({ devbox: devboxView({ connection: "reconnecting" }) }) },
};

export const Empty: Story = {
  args: {
    machines: fakeMachines({ home: fakeView({ organized: { chats: [], projects: [], archived: [] } }) }).slice(0, 1),
    shownId: undefined,
  },
};
