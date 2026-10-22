import { Button } from "@astryxdesign/core/Button";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { Plus } from "@/shared/ui/icons.tsx";
import { ChatPromptInput } from "./chat-prompt-input.tsx";

const meta = {
  title: "Shared/Chat/ChatPromptInput",
  component: ChatPromptInput,
  args: {
    value: "",
    placeholder: "Ask the agent…",
    onSubmit: fn(),
    onStop: fn(),
    onValueChange: fn(),
  },
  // The composer is controlled; keep the draft locally so typing works.
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return (
      <ChatPromptInput
        {...args}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          args.onValueChange?.(next);
        }}
      />
    );
  },
} satisfies Meta<typeof ChatPromptInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithDraft: Story = {
  args: { value: "Fix the failing parser test and rerun the suite." },
};

// An empty draft mid-run shows the stop button instead of send.
export const StreamingStop: Story = {
  args: { status: "streaming", placeholder: "Steer the running turn…" },
};

export const StreamingSteerDraft: Story = {
  args: {
    status: "streaming",
    placeholder: "Steer the running turn…",
    value: "Skip the e2e tests for now.",
    endActions: <Button label="Follow-up" variant="ghost" size="sm" onClick={fn()} />,
  },
};

export const WithActionsAndFooter: Story = {
  args: {
    startActions: (
      <Button label="More actions" variant="ghost" size="sm" isIconOnly icon={<Plus aria-hidden="true" />} />
    ),
    footer: <span className="text-xs text-muted">Runs in ~/code/opensource/pinomad on main</span>,
  },
};

export const WithError: Story = {
  args: { value: "Describe this screenshot", error: "This model does not accept images." },
};

export const Disabled: Story = {
  args: { isDisabled: true, placeholder: "Reconnecting to the host…" },
};
