import { ToastViewport } from "@astryxdesign/core/Toast";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";
import { createKnownHostsStore } from "../../entities/account/known-hosts.ts";
import { ACCOUNT_HOSTS, signedIn, withAccount } from "../../test/story-fixtures.tsx";
import { NewHostNotices } from "./new-host-notice.tsx";

/** This device already knew every account host but omarchy, so omarchy is announced. */
function Notices() {
  const [knownHosts] = useState(() => {
    const entries = new Map<string, string>();
    const store = createKnownHostsStore({
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => void entries.set(key, value),
    });
    store.arrivals(
      { serverOrigin: "https://pinomad.si", user: "kieran" },
      ACCOUNT_HOSTS.filter((match) => match.host.name !== "omarchy").map((match) => match.host.hostId),
    );
    return store;
  });
  return (
    <ToastViewport position="topEnd" isTopLayer>
      <NewHostNotices knownHosts={knownHosts} />
    </ToastViewport>
  );
}

const meta = {
  title: "Widgets/Account/NewHostNotices",
  component: Notices,
  parameters: { canvasWidth: "full" },
  decorators: [withAccount(signedIn())],
} satisfies Meta<typeof Notices>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "New host omarchy joined your account" (#496), with Remove (#512) and the toast's own dismiss. */
export const Announced: Story = {};

/** Remove goes straight to the password confirmation for that host. */
export const Removing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Remove", hidden: true }));
  },
};
