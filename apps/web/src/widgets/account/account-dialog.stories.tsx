import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { AccountDialog } from "./account-dialog.tsx";

const meta = {
  title: "Widgets/Account/AccountDialog",
  component: AccountDialog,
  decorators: [withHosts()],
  args: { onClose: fn() },
} satisfies Meta<typeof AccountDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = { decorators: [withAccount(signedIn())] };

export const SignedOut: Story = { decorators: [withAccount({ status: "signed-out", mode: "bearer" })] };
