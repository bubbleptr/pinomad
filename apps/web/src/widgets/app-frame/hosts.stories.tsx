import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { DEVBOX_HOST, fakeHosts, HOME_HOST, signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { HostsFallback, HostsMenu, HostsSection } from "./hosts.tsx";

// Picking or forgetting a host reloads the page, so these stories are for looking, not clicking.
const meta = {
  title: "Widgets/AppFrame/Hosts",
  component: HostsSection,
  args: { connection: "connected", connectedHostKey: HOME_HOST.hostKey },
} satisfies Meta<typeof HostsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Section: Story = { decorators: [withHosts()] };

export const SectionReconnecting: Story = { decorators: [withHosts()], args: { connection: "reconnecting" } };

/** A host paired before 5.12 announced no name, so it shows its address. */
export const SectionUnnamedHost: Story = {
  decorators: [withHosts(fakeHosts([HOME_HOST, { ...DEVBOX_HOST, name: undefined }]))],
};

export const SectionEmpty: Story = {
  decorators: [withHosts(fakeHosts([], null))],
  args: { connection: undefined, connectedHostKey: undefined },
};

/** The sidebar footer's hosts button, opened. */
export const Menu: Story = {
  decorators: [withHosts()],
  render: (args) => (
    <div className="flex justify-end pt-40">
      <HostsMenu {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Hosts" }));
  },
};

/** What the connection-failure screens show under their message. */
export const Fallback: Story = {
  decorators: [withHosts(), withAccount(signedIn())],
  render: () => <HostsFallback />,
};
