import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { fakeAccount } from "../../test/story-fixtures.tsx";
import { SignInScreen } from "./sign-in.tsx";

// The signed-out screen (ADR-0044). The fake server offers sign-up, mailed
// codes and all three providers; each story starts from what the account
// model reports.

const meta = {
  title: "Widgets/Account/SignIn",
  component: SignInScreen,
  args: { account: fakeAccount({ status: "signed-out", mode: "cookie" }) },
} satisfies Meta<typeof SignInScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The page the server serves: providers, then email and password. */
export const WithProviders: Story = {};

/** A server with no providers and no mail: email and password only. */
export const EmailOnly: Story = {
  args: {
    account: {
      ...fakeAccount({ status: "signed-out", mode: "cookie" }),
      authMethods: async () => ({ ok: true as const, value: { registration: false, email: false, providers: [] } }),
    },
  },
};

/** The desktop app picks its server and signs in to providers through the system browser. */
export const Desktop: Story = {
  args: {
    account: { ...fakeAccount({ status: "signed-out", mode: "bearer" }), providerFlow: "loopback" },
    server: { origin: "https://pinomad.si", setOrigin: () => {} },
  },
};

/** A provider sign-in came back refused (`?oauth_error=`). */
export const ProviderRefused: Story = { args: { initialError: "access_denied" } };

/** Create an account, step 2: the mailed code and a new password. */
export const CreateAccountCode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Create an account" }));
    await userEvent.type(canvas.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(canvas.getByRole("button", { name: "Send code" }));
  },
};

/** Forgot password, step 1. */
export const ResetPassword: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Forgot password?" }));
  },
};
