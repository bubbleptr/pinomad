import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { PendingSignInSteps } from "./pending-sign-in.tsx";

// A Google sign-in that found no account yet (ADR-0044 §4), as the dialog
// opened from `?oauth_pending=` shows it.

const meta = {
  title: "Widgets/Account/PendingSignIn",
  component: PendingSignInSteps,
  args: {
    account: fakeAccount({ status: "signed-out", mode: "cookie" }),
    id: "p".repeat(43),
    navigate: fn(),
    onDone: fn(),
  },
} satisfies Meta<typeof PendingSignInSteps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Choice: Story = {};

/** A server that can't mail codes: the new account needs a password. */
export const NeedsPassword: Story = {
  args: {
    account: {
      ...fakeAccount({ status: "signed-out", mode: "cookie" }),
      authMethods: async () => ({ ok: true as const, value: { registration: true, email: false, providers: ["google"] } }),
    },
  },
};

/** Signed out: sign in and link in one form. */
export const SignInAndLink: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "I already have an account" }));
  },
};

/** Signed in: link to this account after the confirmation. */
export const LinkToCurrent: Story = {
  args: { account: fakeAccount(signedIn()) },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "I already have an account" }));
  },
};

export const Expired: Story = {
  args: {
    account: {
      ...fakeAccount({ status: "signed-out", mode: "cookie" }),
      pendingSignIn: async () => ({ ok: false as const, error: { code: "not_found", status: 404 } }),
    },
  },
};
