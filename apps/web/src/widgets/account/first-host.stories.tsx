import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { AccountState } from "../../entities/account/account-model.ts";
import { Centered } from "../../shared/ui/centered.tsx";
import { signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { FirstHost } from "./first-host.tsx";

const noHosts = signedIn({ hosts: [] }) as Extract<AccountState, { status: "signed-in" }>;
const command = "npm i -g pinomad && pinomad join https://app.pinomad.si join-7f3a9c";
const joinToken = (expiresAt: number) =>
  fn(async () => ({ ok: true as const, value: { token: "join-7f3a9c", expiresAt, command } }));

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

/** Signed in, no hosts at all: the command is ready to copy. */
export const Default: Story = {};

/** The single-use command ran out; New command mints another. */
export const Expired: Story = {
  decorators: [withAccount(noHosts, { createJoinToken: joinToken(Date.now() - 1) })],
};

export const CreateFailed: Story = {
  decorators: [
    withAccount(noHosts, {
      createJoinToken: fn(async () => ({ ok: false as const, error: { code: "network" } })),
    }),
  ],
};

/** A failed refresh keeps the screen and says why no host shows up yet. */
export const RefreshFailed: Story = {
  args: { state: { ...noHosts, hostsError: { code: "network" } } },
};
