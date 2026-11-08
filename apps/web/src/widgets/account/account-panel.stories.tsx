import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
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
  decorators: [withAccount({ status: "signed-out", mode: "bearer" }, { providerFlow: "loopback" })],
};

/** After signing out of a self-hosted server, the field keeps that server. */
export const SignedOutSelfHosted: Story = {
  decorators: [
    withAccount({ status: "signed-out", mode: "bearer", serverOrigin: "https://nomad.example.com" }, { providerFlow: "loopback" }),
  ],
};

/** The account's other pages, as the overview opens them. */


export const HostsOnAccount: Story = { args: { initialPage: "hosts" }, decorators: [withAccount(signedIn())] };

const body = () => within(document.body);

/** Add a host (#496): the command without a token, the code field, and the token command under Advanced. */
export const AddingHost: Story = {
  args: { initialPage: "hosts" },
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Add a host" }));
  },
};

/** Changing the password (#450), in its own dialog. */
export const ChangingPassword: Story = {
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Change password" }));
  },
};

/** An account without a password confirms by a mailed code (ADR-0044 §6). */
export const DeletingAccountByCode: Story = {
  decorators: [
    withAccount(signedIn(), {
      identities: fn(async () => ({
        ok: true as const,
        value: { hasPassword: false, identities: [{ provider: "google", email: "kieran@gmail.com", createdAt: 0 }] },
      })),
    }),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Delete account" }));
    await userEvent.click(await body().findByRole("button", { name: "Send code" }));
  },
};

/** Signing out (#494): the shared-computer choice, off until ticked. */
export const SigningOut: Story = {
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Sign out" }));
  },
};

/** Ticked: this device also leaves the account's hosts. */
export const SigningOutSharedComputer: Story = {
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Sign out" }));
    await userEvent.click(await body().findByRole("checkbox", { name: /shared computer/ }));
  },
};

/** Signing out everywhere asks first. */
export const SigningOutEverywhere: Story = {
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Sign out everywhere" }));
  },
};

/** Deleting the account (#451): the password again, and what stays on the hosts. */
export const DeletingAccount: Story = {
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Delete account" }));
  },
};

/** A wrong password keeps the session and the form. */
export const DeleteAccountWrongPassword: Story = {
  decorators: [
    withAccount(signedIn(), {
      deleteAccount: fn(async () => ({ ok: false as const, error: { code: "wrong_password", status: 403 } })),
    }),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Delete account" }));
    await userEvent.type(await body().findByLabelText("Password"), "not my password{Enter}");
  },
};

/** Removing a device (#452): the password again, and which hosts can't be asked to revoke it. */
export const RemovingDevice: Story = {
  decorators: [
    withAccount(
      signedIn({
        hosts: [
          ...ACCOUNT_HOSTS,
          // An older host that doesn't report devices: the form names it.
          { ...ACCOUNT_HOSTS[1]!, host: { ...ACCOUNT_HOSTS[1]!.host, hostId: "a".repeat(43), name: "attic", deviceReports: false } },
        ],
      }),
    ),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "More for Mac Desktop" }));
    await userEvent.click(await body().findByRole("menuitem", { name: "Remove" }));
  },
};

/** A wrong password keeps the form; nothing is removed. */
export const RemoveDeviceWrongPassword: Story = {
  decorators: [
    withAccount(signedIn(), {
      kickDevice: fn(async () => ({ ok: false as const, error: { code: "wrong_password", status: 403 } })),
    }),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "More for Mac Desktop" }));
    await userEvent.click(await body().findByRole("menuitem", { name: "Remove" }));
    await userEvent.type(await body().findByLabelText("Password"), "not my password{Enter}");
  },
};

/** Removing a host from the account (#512): the password again, and what that does to the host. */
export const RemovingHost: Story = {
  args: { initialPage: "hosts" },
  decorators: [withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "More for omarchy" }));
    await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Remove from account" }));
  },
};

/** A wrong password keeps the form; the host stays. */
export const RemoveHostWrongPassword: Story = {
  args: { initialPage: "hosts" },
  decorators: [
    withAccount(signedIn(), {
      removeHost: fn(async () => ({ ok: false as const, error: { code: "wrong_password", status: 403 } })),
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "More for omarchy" }));
    await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Remove from account" }));
    await userEvent.type(await within(document.body).findByLabelText("Password"), "not my password{Enter}");
  },
};

export const Checking: Story = { decorators: [withAccount({ status: "checking" })] };

export const RefreshFailed: Story = {
  args: { initialPage: "hosts" },
  decorators: [withAccount(signedIn({ hostsError: { code: "network" } }))],
};

/** The connected host refused this device, another reinstalled with a new key, and a pairing wasn't saved. */
export const NeedsRepair: Story = {
  args: { initialPage: "hosts" },
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
