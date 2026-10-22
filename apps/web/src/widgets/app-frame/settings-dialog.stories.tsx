import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { fakeRemote, fakeView, HOME_HOST, SELF, withDesktopUpdates, withHosts } from "../../test/story-fixtures.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/AppFrame/SettingsDialog",
  component: SettingsDialog,
  decorators: [withHosts()],
  parameters: { canvasWidth: "full" },
  args: { view, remote: fakeRemote(view), device: SELF, hostKey: HOME_HOST.hostKey, onClose: fn() },
} satisfies Meta<typeof SettingsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The open section is the dialog's own state: a story picks one by clicking it
 * in the section nav, or, at 640px and below, in the list the dialog opens on.
 */
const open = (section: string): Story => ({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.queryByRole("navigation", { name: "Settings sections" });
    await userEvent.click((nav === null ? canvas : within(nav)).getByText(section));
  },
});

/** Connected, the dialog lands on the host's providers. */
export const Providers: Story = {};

export const Models: Story = open("Models");

export const Agents: Story = open("Agents");

export const Mcp: Story = open("MCP");

export const Chats: Story = open("Chats");

export const Devices: Story = open("Devices");

export const Archived: Story = open("Archived");

export const About: Story = open("About");

export const Hosts: Story = open("Hosts");

/** The desktop app adds Updates under "This device". */
export const Updates: Story = {
  ...open("Updates"),
  decorators: [withDesktopUpdates({ state: "ready", currentVersion: "0.9.0", availableVersion: "0.10.0" })],
};

/** Disconnected, the host group has nothing live, so the dialog lands on this device's hosts. */
export const Disconnected: Story = { args: { view: fakeView({ connection: "reconnecting" }) } };

/** A pre-5.2 host has no settings or auth streams. */
export const OlderHost: Story = {
  args: { view: fakeView({ settings: null, auth: null, agents: null, mcp: null, host: { protocol: { major: 5, minor: 1 } } }) },
};
