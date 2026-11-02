import type { Meta, StoryObj } from "@storybook/react-vite";
import { DEVBOX_HOST, fakeHosts, HOME_HOST, signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { DeviceRejected } from "./device-rejected.tsx";

const meta = {
  title: "App frame/Device rejected",
  component: DeviceRejected,
  parameters: { canvasWidth: "full" },
  decorators: [
    (Story) => (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeviceRejected>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Signed out: a fresh pairing link is the way back, the account a hint below it. */
export const SignedOut: Story = {
  args: { hostKey: DEVBOX_HOST.hostKey },
  decorators: [withHosts(fakeHosts([DEVBOX_HOST], DEVBOX_HOST.hostKey)), withAccount({ status: "signed-out", mode: "cookie" })],
};

/** The signed-in account vouches for this host: re-pairing through it leads, the link steps back. */
export const ThroughAccount: Story = {
  args: { hostKey: HOME_HOST.hostKey },
  decorators: [withHosts(fakeHosts([HOME_HOST], HOME_HOST.hostKey)), withAccount(signedIn())],
};
