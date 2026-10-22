import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { AppUpdate } from "./use-app-update.ts";
import type { UpdateStatus } from "./update-protocol.ts";
import { UpdateStatusNote } from "./update-status-note.tsx";

const update = (status: UpdateStatus): AppUpdate => ({ status, check: fn(), install: fn() });

const meta = {
  title: "Entities/AppUpdate/UpdateStatusNote",
  component: UpdateStatusNote,
  args: { update: undefined },
} satisfies Meta<typeof UpdateStatusNote>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Also what the note shows before the bridge's first status lands. */
export const Checking: Story = {};

export const Downloading: Story = {
  args: { update: update({ state: "downloading", currentVersion: "0.1.0", availableVersion: "0.2.0", progressPercent: 42.6 }) },
};

export const Ready: Story = {
  args: { update: update({ state: "ready", currentVersion: "0.1.0", availableVersion: "0.2.0" }) },
};

export const Failed: Story = {
  args: { update: update({ state: "error", currentVersion: "0.1.0", message: "update feed unreachable" }) },
};

export const UpToDate: Story = {
  args: { update: update({ state: "idle", currentVersion: "0.1.0" }) },
};

export const Disabled: Story = {
  args: { update: update({ state: "disabled", currentVersion: "0.1.0", reason: "Updates are unavailable in this build." }) },
};
