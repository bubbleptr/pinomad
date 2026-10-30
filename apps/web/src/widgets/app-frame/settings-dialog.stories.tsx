import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { fakeMachines, fakeView, HOME_HOST, NAS_HOST, withDesktopUpdates, withHosts } from "../../test/story-fixtures.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";

const meta = {
  title: "Widgets/AppFrame/SettingsDialog",
  component: SettingsDialog,
  decorators: [withHosts()],
  parameters: { canvasWidth: "full" },
  args: { machines: fakeMachines(), initialKey: HOME_HOST.hostKey, onClose: fn() },
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
export const Disconnected: Story = {
  args: { machines: fakeMachines({ home: fakeView({ connection: "reconnecting" }) }).slice(0, 1) },
};

/** The only host is still connecting: only "This device" exists, so it opens there. */
export const HostNotReady: Story = { args: { machines: fakeMachines().slice(2), initialKey: NAS_HOST.hostKey } };

/** With several machines the host group picks one; one that isn't connected explains itself. */
export const PickedMachineNotReady: Story = { ...open("Models"), args: { initialKey: NAS_HOST.hostKey } };

/** A pre-5.1 host has no settings, auth or providers streams. */
export const OlderHost: Story = {
  args: {
    machines: fakeMachines({
      home: fakeView({ settings: null, auth: null, providers: null, agents: null, mcp: null, host: { protocol: { major: 5, minor: 0 } } }),
    }),
  },
};
