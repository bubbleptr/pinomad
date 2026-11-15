import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { fakeRemote, GITHUB_PLUGIN, PINOMAD, withInbox } from "../../test/story-fixtures.tsx";
import { AddSourceDialog, WebhookAccessDialog } from "./inbox-sources.tsx";

const view = withInbox();
const remote = fakeRemote(view);

const meta = {
  title: "Widgets/SidePanel/AddSourceDialog",
  component: AddSourceDialog,
  args: { project: PINOMAD.path, remote, connected: true, plugins: [GITHUB_PLUGIN], externalSources: true, onClose: fn() },
} satisfies Meta<typeof AddSourceDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A schedule: the first tab. Its note is yours, so its tasks get all tools and there's no choice to make. */
export const Schedule: Story = {};

/** Add pressed with nothing filled in. */
export const ScheduleInvalid: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
  },
};

/** One of a plugin's sources and its filter; restricted to start with. */
export const Plugin: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("radio", { name: "Plugin" }));
  },
};

/** No loaded plugin declares a source. */
export const PluginNone: Story = {
  args: { plugins: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("radio", { name: "Plugin" }));
  },
};

export const Webhook: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("radio", { name: "Webhook" }));
  },
};

/** A host without a sandbox for Inbox runs takes schedules only. */
export const SchedulesOnly: Story = { args: { externalSources: false } };

/** The host refuses: its reason sits above the buttons and the form stays. */
export const Refused: Story = {
  args: {
    remote: { ...remote, controller: { ...remote.controller, addInboxSource: fn(async () => Promise.reject(new Error("This schedule never fires"))) } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.type(canvas.getByRole("textbox", { name: "Name" }), "Leap day");
    await userEvent.type(canvas.getByRole("textbox", { name: "Task" }), "Celebrate.");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
  },
};

/** A new webhook's URL, source id and secret, shown this once. */
export const WebhookAdded: Story = {
  render: () => (
    <WebhookAccessDialog
      title="Webhook added"
      access={{ url: "http://192.168.1.20:7432/inbox/pinomad-3f9a1c02de/events", source: "src-new", secret: "whsec_Hk2pQ9xN4vL7tR1sW8yB3mC6dF0gJ5aE" }}
      remote={remote}
      connected
      onClose={fn()}
    />
  ),
};
