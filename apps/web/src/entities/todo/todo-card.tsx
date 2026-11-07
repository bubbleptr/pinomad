// The todo list under the newest run (ADR-0026 §4): always that run's last
// element, shown while the run is going and either wrote the list or has
// something on it still unfinished. A settled run drops it.
import { Collapsible } from "@base-ui-components/react/collapsible";
import { useState } from "react";
import type { ChatEntry } from "@pinomad/client/cot-view.ts";
import type { TodoItem, TodoState } from "@pinomad/protocol/presentation.ts";
import { CheckCircle, ChevronRight, Circle } from "@/shared/ui/icons";
import { useNow } from "@/shared/use-now";

/** Coarse on purpose: the label only says whether the plan is fresh. */
export function formatUpdatedAgo(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

/** Minute labels need no faster clock than this. */
function UpdatedAgo({ atMs }: { atMs: number }) {
  const now = useNow(30_000);
  return <span className="todo-card__updated">{formatUpdatedAgo(now - atMs)}</span>;
}

const STATUS_LABEL = { pending: "Not started", in_progress: "In progress", completed: "Done" } as const;

// The ring of the pending Circle (r 10 on 24) cut into eight dashes that turn
// slowly: shape alone tells it from a pending ring, so it still reads with
// motion reduced, and the slow turn says "being worked on" without looking
// like a loading spinner. Round caps eat a stroke width out of each gap.
const RING = 2 * Math.PI * 10;
const DASH = RING / 8 - 4.4;

function RunningRing(props: { "aria-label": string; role: "img"; className: string }) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeLinecap="round" strokeDasharray={`${DASH} ${RING / 8 - DASH}`} />
    </svg>
  );
}

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  const props = { "aria-label": STATUS_LABEL[status], role: "img", className: "todo-card__status" } as const;
  if (status === "in_progress") return <RunningRing {...props} className="todo-card__status todo-card__status--running" />;
  return status === "completed" ? <CheckCircle {...props} /> : <Circle {...props} />;
}

/**
 * When the list last changed: the latest `todoWrittenAtMs` across every run,
 * not the newest run's — the run the card sits under often never touched the
 * list, and that is when its age matters most.
 */
export function lastTodoWriteMs(entries: readonly ChatEntry[]): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    const writtenAtMs = entry.kind === "run" ? entry.cot.todoWrittenAtMs : undefined;
    if (writtenAtMs !== undefined && (latest === undefined || writtenAtMs > latest)) latest = writtenAtMs;
  }
  return latest;
}

export function TodoCard({
  todo,
  writtenThisRun,
  updatedAtMs,
  settled = false,
}: {
  /** The conversation's `pinomad.todo` document, when it has a valid one. */
  todo: TodoState | undefined;
  /** The run the card sits under wrote the list. */
  writtenThisRun: boolean;
  /** When any run last wrote the list (`lastTodoWriteMs`); absent when none did. */
  updatedAtMs?: number;
  /** The run is over: a list it never ticked off would otherwise linger. */
  settled?: boolean;
}) {
  const items = todo?.items ?? [];
  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const allDone = completed === total;
  // Unset until the user toggles: a finished list folds by itself, but an
  // explicit choice is never overridden.
  const [userOpen, setUserOpen] = useState<boolean>();

  if (settled || total === 0 || (!writtenThisRun && allDone)) {
    return null;
  }

  const open = userOpen ?? !allDone;
  const current = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");

  return (
    <section className="todo-card" data-slot="todo-card" aria-label="Todo">
      <Collapsible.Root open={open} onOpenChange={setUserOpen}>
        <div className="todo-card__header">
          <Collapsible.Trigger className="todo-card__trigger">
            {allDone ? <CheckCircle aria-label="All done" role="img" className="todo-card__done" /> : null}
            <span className="todo-card__title">
              Todo {completed}/{total}
            </span>
            {!open && current !== undefined ? (
              <>
                {" "}
                <span className="todo-card__current">· {current.text}</span>
              </>
            ) : null}
            <ChevronRight aria-hidden="true" className="chat-step__chevron" />
          </Collapsible.Trigger>
          {updatedAtMs === undefined ? null : <UpdatedAgo atMs={updatedAtMs} />}
        </div>
        <Collapsible.Panel className="todo-card__panel">
          <ol className="todo-card__items">
            {items.map((item, index) => (
              <li key={index} className="todo-card__item" data-status={item.status}>
                <StatusIcon status={item.status} />
                {item.status === "completed" ? <s>{item.text}</s> : <span>{item.text}</span>}
              </li>
            ))}
          </ol>
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
}
