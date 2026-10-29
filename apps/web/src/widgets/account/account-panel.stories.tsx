import type { Meta, StoryObj } from "@storybook/react-vite";
import { ACCOUNT_HOSTS, HOME_HOST, signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { AccountPanel } from "./account-panel.tsx";

const meta = {
  title: "Widgets/Account/AccountPanel",
  component: AccountPanel,
  // Story decorators wrap inside this, so a story's withAccount sees the hosts.
  decorators: [withHosts()],
} satisfies Meta<typeof AccountPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = { decorators: [withAccount(signedIn())] };

export const SignedOut: Story = { decorators: [withAccount({ status: "signed-out", mode: "cookie" })] };

/** Clients that pick their server (the desktop app) ask for it, prefilled from the last session. */
export const SignedOutPickServer: Story = {
  decorators: [withAccount({ status: "signed-out", mode: "bearer", serverOrigin: "https://pinomad.si" })],
};

export const Checking: Story = { decorators: [withAccount({ status: "checking" })] };

export const RefreshFailed: Story = {
  decorators: [withAccount(signedIn({ hostsError: { code: "network" } }))],
};

/** The connected host refused this device, another reinstalled with a new key, and a pairing wasn't saved. */
export const NeedsRepair: Story = {
  decorators: [
    withAccount(
      signedIn({
        hosts: [ACCOUNT_HOSTS[0]!, { ...ACCOUNT_HOSTS[1]!, status: "key_changed", stored: { ...HOME_HOST, hostKey: "K".repeat(43) } }],
        rejectedHostKeys: [HOME_HOST.hostKey],
        unsavedHosts: [HOME_HOST],
      }),
    ),
  ],
};
