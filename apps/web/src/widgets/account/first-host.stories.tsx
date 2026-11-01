import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { AccountState } from "../../entities/account/account-model.ts";
import { Centered } from "../../shared/ui/centered.tsx";
import { signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { FirstHost } from "./first-host.tsx";

const noHosts = signedIn({ hosts: [] }) as Extract<AccountState, { status: "signed-in" }>;
const command = "curl -fsSL https://pinomad.si/install.sh | sh && PATH=\"$HOME/.local/bin:$PATH\" pinomad join https://pinomad.si join-7f3a9c";
const joinToken = (expiresAt: number) =>
  fn(async () => ({ ok: true as const, value: { token: "join-7f3a9c", expiresAt, command } }));

const openAdvanced = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByRole("button", { name: /Advanced: join with a one-time token/ }));
};

const meta = {
  title: "Widgets/Account/FirstHost",
  component: FirstHost,
  // App renders it inside the no-host page shell.
  decorators: [
    (Story) => (
      <Centered>
        <Story />
      </Centered>
    ),
    withAccount(noHosts, { createJoinToken: joinToken(Date.now() + 10 * 60_000) }),
    withHosts(),
  ],
  parameters: { canvasWidth: "full" },
  args: { state: noHosts },
} satisfies Meta<typeof FirstHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Signed in, no hosts at all: the command without a token and the field for the code it prints. */
export const Default: Story = {};

/** For scripts: the one-time token command, minted only once Advanced opens. */
export const TokenCommand: Story = { play: openAdvanced };

/** The single-use command ran out; New command mints another. */
export const TokenExpired: Story = {
  decorators: [withAccount(noHosts, { createJoinToken: joinToken(Date.now() - 1) })],
  play: openAdvanced,
};

export const TokenCreateFailed: Story = {
  decorators: [
    withAccount(noHosts, {
      createJoinToken: fn(async () => ({ ok: false as const, error: { code: "network" } })),
    }),
  ],
  play: openAdvanced,
};

/** A failed refresh keeps the screen and says why no host shows up yet. */
export const RefreshFailed: Story = {
  args: { state: { ...noHosts, hostsError: { code: "network" } } },
};

/** Hosts paired without an account: the pasted-link form, one click under the command. */
export const PairingLink: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Have a pairing link?" }));
  },
};
