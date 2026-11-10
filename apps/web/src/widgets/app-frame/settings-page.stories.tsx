import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import {
  fakeMachines,
  fakeView,
  HOME_HOST,
  NAS_HOST,
  withDesktopLocalHost,
  withDesktopUpdates,
  signedIn,
  withAccount,
  withHosts,
} from "../../test/story-fixtures.tsx";
import { SettingsPage } from "./settings-page.tsx";

const meta = {
  title: "Widgets/AppFrame/SettingsPage",
  component: SettingsPage,
  decorators: [withHosts()],
  parameters: { canvasWidth: "full" },
  args: { machines: fakeMachines(), initialKey: HOME_HOST.hostKey, onClose: fn() },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The open section is the page's own state: a story picks one by clicking it
 * in the section nav, or, narrow, in the list the page opens on.
 */
const open = (section: string): Story => ({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.queryByRole("navigation", { name: "Settings sections" });
    await userEvent.click((nav === null ? canvas : within(nav)).getByText(section));
  },
});

/** Connected, the page lands on the host's providers. */
export const Providers: Story = {};

/** A narrow window: no nav beside the page, which opens on the section list instead. */
export const Narrow: Story = { args: { narrow: true } };

export const Models: Story = open("Models");

export const Agents: Story = open("Agents");

export const Chats: Story = open("Chats");

export const Devices: Story = open("Devices");

export const About: Story = open("About");

export const Hosts: Story = open("Hosts");

/** Signed in: the account's own group, opened from the sidebar's account. */
export const Account: Story = { decorators: [withAccount(signedIn())], args: { initialSection: "account" } };

/** Signed out, the group is only the sign-in form. */
export const AccountSignedOut: Story = {
  decorators: [withAccount({ status: "signed-out", mode: "cookie" })],
  args: { initialSection: "account" },
};

export const General: Story = open("General");

/** The desktop app adds its updates to General. */
export const GeneralWithUpdates: Story = {
  ...open("General"),
  decorators: [withDesktopUpdates({ state: "ready", currentVersion: "0.9.0", availableVersion: "0.10.0" })],
};

/** The Mac app puts This Mac, the switch over the host installed here (#501), over the hosts. */
export const HostsOnMac: Story = {
  ...open("Hosts"),
  decorators: [
    withDesktopLocalHost({ state: { kind: "installed", running: true, stopped: false, stopping: false, detail: "running (pid 4242)" } }),
  ],
};

/** Disconnected, the host group has nothing live, so the page lands on this device's hosts. */
export const Disconnected: Story = {
  args: { machines: fakeMachines({ home: fakeView({ connection: "reconnecting" }) }).slice(0, 1) },
};

/** The only host is still connecting: only "This device" exists, so it opens there. */
export const HostNotReady: Story = { args: { machines: fakeMachines().slice(2), initialKey: NAS_HOST.hostKey } };

/** With several machines the host page picks one; one that isn't connected explains itself. */
export const PickedMachineNotReady: Story = { ...open("Models"), args: { initialKey: NAS_HOST.hostKey } };

/** A pre-5.1 host has no settings, auth or providers streams. */
export const OlderHost: Story = {
  args: {
    machines: fakeMachines({
      home: fakeView({ settings: null, auth: null, providers: null, agents: null, mcp: null, host: { protocol: { major: 5, minor: 0 } } }),
    }),
  },
};
