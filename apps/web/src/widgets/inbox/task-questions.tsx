// The questions an Inbox's tasks wait on, shown in its intake (#846): the user
// answers them where they talk to the Inbox instead of opening each task. Each
// card is the task conversation's own request, answered there, so auto mode's
// one-time Allow (ADR-0051 §7) stays exactly what the task asked.
import type { InboxTask, ProjectInbox } from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { QuestionCard } from "../../presentation/question.tsx";
import { Button } from "../../shared/ui/button.tsx";

export function TaskQuestions({
  inbox,
  remote,
  connected,
  onOpenTask,
}: {
  inbox: ProjectInbox;
  remote: RemoteDurable;
  connected: boolean;
  onOpenTask: (task: InboxTask) => void;
}) {
  const asking = inbox.tasks.flatMap((task) =>
    task.conversationId === undefined ? [] : (task.questions ?? []).map((question) => ({ task, ...question })),
  );
  if (asking.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 p-2" data-testid="task-questions">
      {asking.map(({ task, kind, request }) => (
        <section key={`${task.id}:${request.id}`} aria-label={task.title} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{task.title}</span>
            <Button variant="secondary" size="sm" aria-label={`Open ${task.title}`} onClick={() => onOpenTask(task)}>
              Open task
            </Button>
          </div>
          <QuestionCard kind={kind} request={request} remote={remote} connected={connected} target={task.conversationId} />
        </section>
      ))}
    </div>
  );
}
