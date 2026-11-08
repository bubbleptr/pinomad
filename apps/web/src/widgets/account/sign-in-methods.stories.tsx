import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { SignInMethods } from "./sign-in-methods.tsx";

// Sign-in methods in the account panel (ADR-0044 §4).

const meta = {
  title: "Widgets/Account/SignInMethods",
  component: SignInMethods,
  args: { account: fakeAccount(signedIn()) },
} satisfies Meta<typeof SignInMethods>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A password and GitHub; Google and Apple can be linked. */
export const PasswordAndGitHub: Story = {};

/** Signed up with GitHub alone: no password yet, and removing it would be the last way in. */
export const ProviderOnly: Story = {
  args: {
    account: {
      ...fakeAccount(signedIn()),
      identities: async () => ({
        ok: true as const,
        value: { hasPassword: false, identities: [{ provider: "github", email: "kieran@users.noreply.github.com", createdAt: 0 }] },
      }),
    },
  },
};

/** Removing a provider on a password-less account: the confirmation is a mailed code. */
export const RemoveWithCode: Story = {
  args: ProviderOnly.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = (await canvas.findByText("GitHub")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Send code" }));
  },
};

/** The desktop app (#631): linking opens the system browser, so the description says to come back. */
export const DesktopLinking: Story = {
  args: { account: { ...fakeAccount(signedIn()), providerFlow: "loopback" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Link Google" }));
  },
};
