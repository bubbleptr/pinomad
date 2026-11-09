import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppearanceSection } from "./appearance-section.tsx";

const meta = {
  title: "Widgets/AppFrame/AppearanceSection",
  component: AppearanceSection,
} satisfies Meta<typeof AppearanceSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
