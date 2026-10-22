import type { Meta, StoryObj } from "@storybook/react-vite";
import { ACCOUNT_HOSTS, HOME_HOST, signedIn, withAccount } from "../../test/story-fixtures.tsx";
import { RepairViaAccount } from "./repair-via-account.tsx";

const meta = {
  title: "Widgets/Account/RepairViaAccount",
  component: RepairViaAccount,
  args: { hostKey: HOME_HOST.hostKey },
} satisfies Meta<typeof RepairViaAccount>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The host refused this device (4401); the account can ask it for a fresh pairing. */
export const Available: Story = { decorators: [withAccount(signedIn({ rejectedHostKeys: [HOME_HOST.hostKey] }))] };

export const HostOffline: Story = {
  decorators: [
    withAccount(
      signedIn({
        hosts: [{ ...ACCOUNT_HOSTS[0]!, host: { ...ACCOUNT_HOSTS[0]!.host, online: false, pairing: "offline" } }],
        rejectedHostKeys: [HOME_HOST.hostKey],
      }),
    ),
  ],
};
