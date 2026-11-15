// The Inbox's cards in a transcript (ADR-0051 §6): the events a worker
// message delivered, drawn in place of that message, and the tasks an
// intake's `inbox_submit` calls filed, each a button to its task.
import type { InboxEvent } from "@pinomad/protocol/inbox.ts";
import type { ToolItem } from "@pinomad/client/tool-item.ts";
import { pinomadOf } from "@pinomad/client/cot-view.ts";
import { sourceLabel } from "../../entities/inbox/inbox.ts";
import type { InboxTranscript } from "../../entities/inbox/inbox-transcript.tsx";
import { TaskDot } from "../../entities/inbox/task-dot.tsx";
import { Inbox } from "../../shared/ui/icons.tsx";
import { messageTime } from "./chat-time.ts";

function Time({ at, today, prefix }: { at: number; today?: number | undefined; prefix: string }) {
  const value = messageTime(at, today);
  if (value === undefined) return null;
  return (
    <time dateTime={value.iso} title={value.full}>
      {`${prefix} ${value.label}`}
    </time>
  );
}

/**
 * The events that started (or continued) a task: where each came from, its
 * summary, when it reached the Inbox, and when the worker handed it over —
 * the message's own time.
 */
export function InboxEventCard({
  events,
  startedAt,
  today,
}: {
  events: readonly InboxEvent[];
  startedAt?: number | undefined;
  today?: number | undefined;
}) {
  return (
    <section aria-label="Inbox events" data-slot="inbox-event-card" className="flex flex-col gap-3 rounded-xl bg-surface-muted px-3 py-2.5">
      {events.map((event, index) => (
        <div key={event.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs/5 text-muted-foreground">
            <Inbox aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{sourceLabel(event.source)}</span>
            <span className="ms-auto flex shrink-0 gap-1 tabular-nums">
              <Time at={event.receivedAt} today={today} prefix="Received" />
              {startedAt === undefined || index !== events.length - 1 ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <Time at={startedAt} today={today} prefix="Started" />
                </>
              )}
            </span>
          </div>
          <p className="text-sm/5 whitespace-pre-wrap">{event.summary}</p>
        </div>
      ))}
    </section>
  );
}

/** A run's `inbox_submit` calls, in call order. */
export function inboxSubmitsOf(tools: readonly ToolItem[]): ToolItem[] {
  return tools.filter((tool) => tool.toolName === "inbox_submit");
}

/** The call's arguments as the model wrote them, which the host may yet refuse: each field is kept only when it is a string. */
function argsOf(tool: ToolItem): { title?: string; mergeInto?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tool.argsText ?? "");
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { title, mergeInto } = parsed as Record<string, unknown>;
  return {
    title: typeof title === "string" ? title : undefined,
    mergeInto: typeof mergeInto === "string" ? mergeInto : undefined,
  };
}

/** One card per filed task: its state light, title and where it stands now. A card opens its task. */
export function InboxTaskCards({ tools, inbox }: { tools: readonly ToolItem[]; inbox: InboxTranscript }) {
  if (tools.length === 0) return null;
  return (
    <ul aria-label="Filed tasks" className="flex flex-col gap-2">
      {tools.map((tool, index) => {
        const args = argsOf(tool);
        const detail = pinomadOf(tool);
        const filed = detail?.kind === "inboxSubmit" ? detail : undefined;
        const taskId = filed?.task;
        const info = taskId === undefined ? undefined : inbox.task(taskId);
        const title = info?.task.title ?? filed?.title ?? args.title ?? "Task";
        const what = (filed?.merged ?? args.mergeInto !== undefined) ? "Added to task" : "New task";
        const description =
          tool.state === "output-error"
            ? "Not filed"
            : info !== undefined
              ? `${what} · ${info.text}`
              : taskId === undefined
                ? "Filing…"
                : what;
        const body = (
          <>
            {info === undefined ? <span className="size-4 shrink-0" /> : <TaskDot state={info.state} />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm/5 font-medium">{title}</span>
              <span className="truncate text-xs/5 text-muted-foreground">{description}</span>
            </span>
          </>
        );
        const card = "flex w-full items-center gap-2.5 rounded-xl border border-border px-3 py-2.5 text-start";
        return (
          <li key={tool.toolCallId ?? index}>
            {info === undefined ? (
              <div className={card}>{body}</div>
            ) : (
              <button
                type="button"
                className={`${card} cursor-pointer [@media(hover:hover)]:hover:bg-surface-hover active:bg-(--surface-pressed)`}
                onClick={() => inbox.openTask(info.task.id)}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
