import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { fakeRemote, fakeUpgrade, fakeView } from "../../test/story-fixtures.tsx";
import { SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { HostUpgradeSection } from "./host-upgrade-section.tsx";

const view = fakeView({ upgrade: fakeUpgrade() });

const meta = {
  title: "Widgets/AppFrame/HostUpgradeSection",
  component: HostUpgradeSection,
  args: { view, remote: fakeRemote(view) },
  // As on the About page: the section is the rows of the Version group.
  decorators: [(Story) => <div className="pigui-settings"><SettingsGroup title="Version"><Story /></SettingsGroup></div>],
} satisfies Meta<typeof HostUpgradeSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {};

export const Confirm: Story = {
  args: { view: fakeView({ upgrade: fakeUpgrade({ available: { version: "1.0.0", publishedAt: Date.now() - 86_400_000, crossesMajor: true } }) }) },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Upgrade" }));
  },
};

export const UpToDate: Story = { args: { view: fakeView({ upgrade: fakeUpgrade({ available: null }) }) } };

export const Waiting: Story = {
  args: { view: fakeView({ upgrade: fakeUpgrade({ phase: "waiting", target: "0.14.0", attempt: 1 }) }) },
};

export const Installing: Story = {
  args: { view: fakeView({ upgrade: fakeUpgrade({ phase: "installing", target: "0.14.0", attempt: 1 }) }) },
};

export const Failed: Story = {
  args: {
    view: fakeView({
      upgrade: fakeUpgrade({
        attempt: 1,
        failure: { version: "0.14.0", attempt: 1, message: "npm ERR! code EACCES\nnpm ERR! permission denied, rename '/usr/local/lib/node_modules/pinomad'" },
      }),
    }),
  },
};

export const NotAService: Story = { args: { view: fakeView({ upgrade: fakeUpgrade({ blocked: "no-service" }) }) } };

export const SourceCheckout: Story = {
  args: { view: fakeView({ upgrade: fakeUpgrade({ current: null, blocked: "source", available: null, checkedAt: null }) }) },
};

export const CheckFailed: Story = {
  args: { view: fakeView({ upgrade: fakeUpgrade({ available: null, checkError: "npm view exited with 1: getaddrinfo ENOTFOUND registry.npmjs.org" }) }) },
};

export const OldHost: Story = { args: { view: fakeView({ upgrade: null, host: { protocol: { major: 5, minor: 29 } } }) } };
