import type { Meta, StoryObj } from "@storybook/react-vite";
import { fakeAccount, signedIn } from "../../test/story-fixtures.tsx";
import { AddEmailCard } from "./add-email-gate.tsx";

// What a legacy account sees after signing in on a server that can mail
// codes (ADR-0044 §8), instead of the app.

const meta = {
  title: "Widgets/Account/AddEmail",
  component: AddEmailCard,
  args: { account: fakeAccount(signedIn({ user: "kieran", email: undefined, needsEmail: true })) },
} satisfies Meta<typeof AddEmailCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
