import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { createStaticSource } from "@/shared/ui/typeahead";
import { ChatBadge } from "./chat-badge";
import { ChatComposer } from "./chat-composer";
import { ChatComposerInput, type ChatComposerTrigger } from "./chat-composer-input";

const agents = createStaticSource([
  { id: "planner", label: "planner", auxiliaryData: { group: "Agents" } },
  { id: "reviewer", label: "reviewer", auxiliaryData: { group: "Agents" } },
  { id: "src/app.tsx", label: "src/app.tsx", auxiliaryData: { group: "Files" } },
  { id: "src/main.tsx", label: "src/main.tsx", auxiliaryData: { group: "Files" } },
]);

const commands = createStaticSource([
  { id: "compact", label: "compact" },
  { id: "model", label: "model" },
  { id: "review", label: "review" },
]);

const triggers: ChatComposerTrigger[] = [
  // Mentions insert a token chip; commands insert plain text.
  { character: "@", searchSource: agents, menuLabel: "Mentions", onSelect: (item) => ({ value: `@${item.id}`, label: `@${item.label}` }) },
  { character: "/", searchSource: commands, menuLabel: "Commands", onSelect: (item) => `/${item.id} ` },
];

const meta = {
  title: "Shared/ChatKit/ChatComposer",
  component: ChatComposer,
  args: {
    onSubmit: fn(),
    onStop: fn(),
    placeholder: "Ask the agent…",
  },
  // Controlled, so typing and submit-clearing behave as in the app.
  render: function Render(args) {
    const [value, setValue] = useState(args.value ?? "");
    return (
      <ChatComposer
        {...args}
        value={value}
        onChange={(next) => {
          setValue(next);
          args.onChange?.(next);
        }}
        input={args.input ?? <ChatComposerInput triggers={triggers} />}
      />
    );
  },
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type `@` or `/` to open a trigger menu; paste over 200 characters to get a token. */
export const Default: Story = {};

export const WithDraft: Story = {
  args: { value: "Fix the failing parser test and rerun the suite." },
};

export const StopShown: Story = {
  args: { isStopShown: true },
};

export const WithHeader: Story = {
  args: {
    header: (
      <div className="flex gap-1">
        <ChatBadge label="screenshot.png" />
        <ChatBadge label="trace.log" />
      </div>
    ),
  },
};

export const WithError: Story = {
  args: { status: { type: "error", message: "This model does not accept images." } },
};

export const WithWarning: Story = {
  args: { status: { type: "warning", message: "Context window is almost full." } },
};

export const Flat: Story = {
  args: { elevation: "none" },
};

export const Disabled: Story = {
  args: { isDisabled: true, placeholder: "Reconnecting to the host…" },
};
