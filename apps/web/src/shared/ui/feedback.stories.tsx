import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert.tsx";
import { Avatar, AvatarFallback, initials } from "./avatar.tsx";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./empty.tsx";
import { Skeleton } from "./skeleton.tsx";
import { Spinner } from "./spinner.tsx";
import { StatusDot } from "./status-dot.tsx";
import { Toaster, useToast } from "./toast.tsx";

// The status and notice components from apps/web/DESIGN.md ("反馈").
const meta = {
  title: "Shared/Feedback",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Alerts: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Alert variant="info">
        <AlertTitle>Host is restarting</AlertTitle>
        <AlertDescription>Upgrading to pinomad 0.15.0. Reconnecting when it's back…</AlertDescription>
      </Alert>
      <Alert variant="success">
        <AlertTitle>omarchy joined your account</AlertTitle>
        <AlertDescription>It will appear in your hosts and connect on its own.</AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTitle>Couldn't refresh hosts</AlertTitle>
        <AlertDescription>The server didn't answer.</AlertDescription>
        <AlertAction>
          <Button size="sm">Retry</Button>
        </AlertAction>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Couldn't pair</AlertTitle>
        <AlertDescription>The host didn't answer in time.</AlertDescription>
      </Alert>
      <Alert variant="destructive" className="rounded-none">
        <AlertTitle>Disconnected from the host</AlertTitle>
      </Alert>
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>This device</Badge>
      <Badge variant="success">Connected</Badge>
      <Badge variant="destructive">deleted</Badge>
      <Badge variant="warning">interrupted</Badge>
      <Badge variant="muted">Removed</Badge>
    </div>
  ),
};

export const Indicators: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <StatusDot variant="success" label="Running" pulsing />
        <StatusDot variant="warning" label="Waiting for your answer" />
        <StatusDot variant="error" label="Failed" />
        <StatusDot variant="neutral" label="Offline" />
        <StatusDot variant="success" label="Connected" tooltip="Connected" />
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-xs/5 text-muted-foreground">Checking for an account…</span>
        </div>
        <Spinner aria-label="Loading folders" />
      </div>
      <div className="flex items-center gap-3">
        <Avatar size="xs" aria-label="kieran@example.com">
          <AvatarFallback>{initials("kieran@example.com")}</AvatarFallback>
        </Avatar>
        <Avatar size="lg" aria-label="Ada Lovelace">
          <AvatarFallback>{initials("Ada Lovelace")}</AvatarFallback>
        </Avatar>
      </div>
    </div>
  ),
};

export const Skeletons: Story = {
  render: () => (
    <div className="flex flex-col gap-2.5">
      <div className="flex justify-end">
        <Skeleton className="h-10" style={{ width: 200 }} />
      </div>
      <Skeleton className="h-7 w-32 rounded-full" index={1} />
      <Skeleton className="h-3 rounded-full" index={2} />
      <Skeleton className="h-3 rounded-full" style={{ width: 220 }} index={3} />
    </div>
  ),
};

export const EmptyStates: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing here yet</EmptyTitle>
          <EmptyDescription>Ask the agent something. Every client sees it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Couldn't open this conversation</EmptyTitle>
          <EmptyDescription>The host didn't send it.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button>Try again</Button>
        </EmptyContent>
      </Empty>
    </div>
  ),
};

function ShowToasts() {
  const toast = useToast();
  useEffect(() => {
    toast({ description: "Kept worktree pinomad/9-dirty", timeout: 0 });
    toast({ description: "omarchy: Unknown project /tmp/gone", type: "error" });
    toast({
      description: "New host omarchy joined your account. Didn't add it? Remove it.",
      timeout: 0,
      action: <Button size="sm">Remove</Button>,
    });
  }, [toast]);
  return null;
}

/** Newest on top; info on the inverted surface, an error in red. */
export const Toasts: Story = {
  parameters: { canvasWidth: "full" },
  render: () => (
    <Toaster>
      <ShowToasts />
    </Toaster>
  ),
};
