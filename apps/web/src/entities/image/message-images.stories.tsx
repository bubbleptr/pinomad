import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MessageImage } from "@pinomad/protocol/images.ts";
import { ImageSourceProvider } from "./image-source.tsx";
import { moss, sky, sunset } from "./image-fixtures.ts";
import { MessageImages } from "./message-images.tsx";

// Distinct refs keep one story's cached bytes out of the next story.
const REF_LOADED = { ref: "story-image-ref-loaded", mimeType: "image/png" as const };
const REF_LOADING = { ref: "story-image-ref-loading", mimeType: "image/png" as const };
const REF_FAILED = { ref: "story-image-ref-failed", mimeType: "image/png" as const };
const neverLoads = () => new Promise<MessageImage>(() => {});
const failsToLoad = () => Promise.reject(new Error("host offline"));

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

export const RefLoaded: Story = {
  args: { images: [REF_LOADED] },
  render: (args) => (
    <ImageSourceProvider load={() => Promise.resolve(sky)}>
      <MessageImages {...args} />
    </ImageSourceProvider>
  ),
};

export const RefLoading: Story = {
  args: { images: [REF_LOADING] },
  render: (args) => (
    <ImageSourceProvider load={neverLoads}>
      <MessageImages {...args} />
    </ImageSourceProvider>
  ),
};

export const RefFailed: Story = {
  args: { images: [REF_FAILED] },
  render: (args) => (
    <ImageSourceProvider load={failsToLoad}>
      <MessageImages {...args} />
    </ImageSourceProvider>
  ),
};
