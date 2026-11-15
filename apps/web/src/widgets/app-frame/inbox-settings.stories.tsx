import type { Meta, StoryObj } from "@storybook/react-vite";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { InboxSettings } from "./inbox-settings.tsx";

const defaults = fakeView();
const custom = fakeView({
  settings: {
    ...defaults.settings!,
    inboxIntakeModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    inboxWorkerModel: { provider: "openai", modelId: "gpt-5" },
    inboxQuietHours: { start: 22 * 60, end: 7 * 60 + 30 },
    custom: ["inboxIntakeModel", "inboxWorkerModel", "inboxQuietHours"],
  },
});

const meta = {
  title: "Widgets/AppFrame/InboxSettings",
  component: InboxSettings,
  decorators: [
    (Story) => (
      <div className="pigui-settings">
        <Story />
      </div>
    ),
  ],
  args: { view: defaults, remote: fakeRemote(defaults) },
} satisfies Meta<typeof InboxSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Both conversations on the default model, and no quiet hours. */
export const Defaults: Story = {};

/** Intake and worker each on their own model, quiet overnight. */
export const Custom: Story = { args: { view: custom, remote: fakeRemote(custom) } };
