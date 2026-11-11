import { Button } from "../button.tsx";
import { IconButton } from "../icon-button.tsx";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { FolderClosed, FolderGitTwo, Plus } from "@/shared/ui/icons.tsx";
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
    endActions: <Button variant="ghost" size="sm" onClick={fn()}>Follow-up</Button>,
  },
};

export const WithActionsAndFooter: Story = {
  args: {
    startActions: (
      <IconButton label="More actions" size="sm" icon={<Plus aria-hidden="true" />} />
    ),
    // The draft's tray: where the conversation will run.
    footer: (
      <span className="flex items-center gap-2">
        <Button variant="ghost" size="sm"><FolderClosed aria-hidden="true" />pinomad</Button>
        <Button variant="ghost" size="sm"><FolderGitTwo aria-hidden="true" />Git worktree</Button>
      </span>
    ),
  },
};

export const WithError: Story = {
  args: { value: "Describe this screenshot", error: "This model does not accept images." },
};

export const Disabled: Story = {
  args: { isDisabled: true, placeholder: "Reconnecting to the host…" },
};
