import type { Meta, StoryObj } from "@storybook/react-vite";
import { SkillMentionText } from "./skill-mentions.tsx";

const meta = {
  title: "Entities/Agent/SkillMentionText",
  component: SkillMentionText,
  args: {
    text: "Run $review on the branch, then $ship it. Leave $HOME and $wrong as plain text.",
    names: ["review", "ship"],
  },
  // Inline text: a bubble gives it a block to sit in.
  decorators: [(Story) => <p><Story /></p>],
} satisfies Meta<typeof SkillMentionText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithMentions: Story = {};

/** Before the scope's skill listing lands nothing is highlighted. */
export const ListingPending: Story = {
  args: { names: undefined },
};
