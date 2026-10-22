import type { Meta, StoryObj } from "@storybook/react-vite";
import { withDesktopUpdates } from "../../test/story-fixtures.tsx";
import { UpdatesSection } from "./updates-section.tsx";

const meta = {
  title: "Widgets/AppFrame/UpdatesSection",
  component: UpdatesSection,
  decorators: [
    (Story) => (
      // The section renders nothing until the bridge's first status arrives.
      <div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UpdatesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const currentVersion = "0.9.0";

// The note itself has every updater state under Entities/AppUpdate/UpdateStatusNote.
export const Idle: Story = { decorators: [withDesktopUpdates({ state: "idle", currentVersion })] };

export const Ready: Story = {
  decorators: [withDesktopUpdates({ state: "ready", currentVersion, availableVersion: "0.10.0" })],
};
