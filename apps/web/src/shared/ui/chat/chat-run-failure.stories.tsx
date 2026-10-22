import { Button } from "@astryxdesign/core/Button";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ChatRunFailure } from "./chat-run-failure.tsx";

const meta = {
  title: "Shared/Chat/ChatRunFailure",
  component: ChatRunFailure,
  args: {
    error: "The provider dropped the connection.",
    onRetry: fn(async () => {}),
  },
} satisfies Meta<typeof ChatRunFailure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Generic: Story = {};

// Raw provider JSON stays behind the details toggle.
export const AuthRejected: Story = {
  args: {
    error: '401 {"error":{"message":"Invalid API key","type":"authentication_error"}}',
    onOpenProviderSettings: fn(),
  },
};

export const RateLimited: Story = {
  args: {
    error: '429 {"error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    modelControl: <Button label="claude-sonnet" size="sm" variant="secondary" onClick={fn()} />,
  },
};

export const NotInSubscription: Story = {
  args: {
    error: '403 {"error":{"message":"Your subscription plan does not include this model"}}',
    onRetry: undefined,
  },
};

// A historical failure: nothing to retry.
export const Historical: Story = {
  args: { error: "503 service unavailable", onRetry: undefined },
};
