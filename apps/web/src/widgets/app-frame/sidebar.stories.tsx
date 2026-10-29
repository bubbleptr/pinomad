import { SideNav } from "@astryxdesign/core/SideNav";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  fakeRemote,
  fakeView,
  HOME_HOST,
  PARSER_ID,
  signedIn,
  withAccount,
  withDesktopUpdates,
  withHosts,
} from "../../test/story-fixtures.tsx";
import { SidebarContent, SidebarFooter, SidebarHeaderBand } from "./sidebar.tsx";

const view = fakeView();

// The SideNav AppFrame mounts these into, minus its resizable width.
const meta = {
  title: "Widgets/AppFrame/Sidebar",
  component: SidebarContent,
  decorators: [withHosts(), withAccount(signedIn())],
  parameters: { canvasWidth: "full" },
  args: { view, remote: fakeRemote(view), draftingChat: false, shownId: PARSER_ID, onDraft: fn(), onOpen: fn() },
  render: (args) => (
    <div className="h-[calc(100vh-3rem)] w-[260px]">
      <SideNav
        header={<SidebarHeaderBand onCollapse={fn()} />}
        footer={<SidebarFooter view={args.view} hostKey={HOME_HOST.hostKey} onOpenSettings={fn()} onOpenAccount={fn()} />}
      >
        <SidebarContent {...args} />
      </SideNav>
    </div>
  ),
} satisfies Meta<typeof SidebarContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DraftingChat: Story = { args: { draftingChat: true, shownId: undefined } };

/** The desktop app marks Settings once an update is downloaded. */
export const UpdateReady: Story = {
  decorators: [withDesktopUpdates({ state: "ready", currentVersion: "0.9.0", availableVersion: "0.10.0" })],
};

/** Without an account, the user chip shows the device's own name. */
export const NoAccount: Story = { decorators: [withAccount({ status: "unavailable" })] };

export const Disconnected: Story = { args: { view: fakeView({ connection: "reconnecting" }) } };

export const Empty: Story = {
  args: { view: fakeView({ organized: { chats: [], projects: [], archived: [] } }), shownId: undefined },
};
