import type { Meta, StoryObj } from "@storybook/react-vite";
import { moss, sky, sunset } from "./image-fixtures.ts";
import { MessageImages } from "./message-images.tsx";

const meta = {
  title: "Entities/Image/MessageImages",
  component: MessageImages,
  args: { images: [sky] },
} satisfies Meta<typeof MessageImages>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const Several: Story = {
  args: { images: [sky, sunset, moss, sky] },
};
