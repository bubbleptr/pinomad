import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
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

/** Clients that pick their server (the desktop app) start from the official one. */
export const SignedOutPickServer: Story = {
  decorators: [withAccount({ status: "signed-out", mode: "bearer" })],
};

/** After signing out of a self-hosted server, the field keeps that server. */
export const SignedOutSelfHosted: Story = {
  decorators: [withAccount({ status: "signed-out", mode: "bearer", serverOrigin: "https://nomad.example.com" })],
};

/** Sign-up with an invite code: the sign-in form's "Create an account" switches to it. */
export const SignUp: Story = {
  decorators: [withAccount({ status: "signed-out", mode: "bearer" })],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Create an account" }));
  },
};

/** The server's admin also manages sign-up invites: one unused, one used, one expired. */
export const SignedInAdmin: Story = { decorators: [withAccount(signedIn({ admin: true }))] };

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
