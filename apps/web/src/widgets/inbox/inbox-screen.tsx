// The main column for an Inbox target with no conversation of its own
// (ADR-0051 §6): a project's intake before its first message, whose send
// opens the intake, or a task the worker has not taken yet.
import { useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { InboxTask, ProjectInbox } from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import type { InboxTarget } from "../../entities/composer/composer-store.ts";
import { describeTasks, taskOrigin } from "../../entities/inbox/inbox.ts";
import { requestNotificationPermission } from "../../entities/conversation/notification-permission.ts";
import { ChatPromptInput } from "../../shared/ui/chat/chat-prompt-input.tsx";
import { Button } from "../../shared/ui/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../shared/ui/empty.tsx";
import { useErrorToast } from "../../shared/ui/toast.tsx";
import { InboxEventCard } from "../chat/inbox-cards.tsx";
import { TaskQuestions } from "./task-questions.tsx";

export function InboxScreen({
  view,
  remote,
  target,
  onOpened,
  onOpenTask,
}: {
  view: DurableView;
  remote: RemoteDurable;
  target: InboxTarget;
  /** The intake the first message to `project` opened; the caller decides whether that intake is still the one shown. */
  onOpened: (id: ConversationId, project: string) => void;
  /** Open a task whose question the intake shows. */
  onOpenTask: (project: string, task: InboxTask) => void;
}) {
  const inbox = view.inbox?.inboxes.find((each) => each.project === target.project);
  const connected = view.connection === "connected";
  if (inbox === undefined) {
    return (
      <Centered>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This project has no Inbox</EmptyTitle>
            <EmptyDescription>It may have been removed from the host.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Centered>
    );
  }
  return target.task === undefined ? (
    <IntakeDraft inbox={inbox} remote={remote} connected={connected} onOpened={onOpened} onOpenTask={(task) => onOpenTask(inbox.project, task)} />
  ) : (
    <QueuedTask inbox={inbox} taskId={target.task} view={view} remote={remote} connected={connected} />
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">{children}</div>;
}

/** Before the intake's first message: the host opens it with that message, so this sends it and then opens it. */
function IntakeDraft({
  inbox,
  remote,
  connected,
  onOpened,
  onOpenTask,
}: {
  inbox: ProjectInbox;
  remote: RemoteDurable;
  connected: boolean;
  onOpened: (id: ConversationId, project: string) => void;
  onOpenTask: (task: InboxTask) => void;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (): void => {
    const text = value.trim();
    if (text === "" || sending || !connected) return;
    requestNotificationPermission();
    setSending(true);
    setError(null);
    remote.controller.sendToIntake(inbox.project, text).then(
      (id) => {
        setSending(false);
        setValue("");
        onOpened(id, inbox.project);
      },
      (reason: unknown) => {
        setSending(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Centered>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Tell the Inbox what needs doing</EmptyTitle>
            <EmptyDescription>
              Describe a bug or a job, or ask how the tasks stand. The intake asks what's unclear and files tasks for the worker; it changes no
              code itself.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Centered>
      <div className="mx-auto w-full max-w-[44rem] px-4 pb-4">
        {/* A scheduled or webhook task can ask before anyone wrote to the intake. */}
        <TaskQuestions inbox={inbox} remote={remote} connected={connected} onOpenTask={onOpenTask} />
        <ChatPromptInput
          value={value}
          onValueChange={setValue}
          placeholder="A bug, a job to do, or a question about progress…"
          isDisabled={!connected}
          status={sending ? "submitted" : "ready"}
          error={error}
          onSubmit={send}
        />
      </div>
    </div>
  );
}

/** A task still in the queue: its events, its place, and Skip. The worker opens its conversation when it takes it. */
function QueuedTask({
  inbox,
  taskId,
  view,
  remote,
  connected,
}: {
  inbox: ProjectInbox;
  taskId: string;
  view: DurableView;
  remote: RemoteDurable;
  connected: boolean;
}) {
  const info = describeTasks(inbox, view.organized).get(taskId);
  const error = useErrorToast();
  const [skipping, setSkipping] = useState(false);
  if (info === undefined) {
    return (
      <Centered>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This task is gone</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </Centered>
    );
  }
  const { task, state, text } = info;
  const skip = (): void => {
    setSkipping(true);
    error.clear();
    remote.controller.skipInboxTask(inbox.project, task.id).then(
      () => setSkipping(false),
      (reason: unknown) => {
        setSkipping(false);
        error.show(`Couldn't skip ${task.title}: ${reason instanceof Error ? reason.message : String(reason)}`);
      },
    );
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-4 px-4 pt-2 pb-6">
        <InboxEventCard events={task.events} />
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-xs/5 text-muted-foreground">
            {state === "pending"
              ? `${taskOrigin(task)} · ${text}. The worker takes tasks one at a time and opens this one's conversation when it starts.`
              : `${taskOrigin(task)} · ${text}`}
          </p>
          {state === "pending" ? (
            <Button variant="secondary" size="sm" loading={skipping} disabled={!connected} onClick={skip}>
              Skip
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
