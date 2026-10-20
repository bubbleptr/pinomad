// The todo list under the newest run (ADR-0026 §4): always that run's last
// element, shown while the run wrote the list or something on it is still
// unfinished. The side panel's Documents view keeps the full read-only copy.
import { Collapsible } from "@base-ui-components/react/collapsible";
import { useState } from "react";
import type { TodoItem, TodoState } from "@pinomad/protocol/presentation.ts";
import { CheckCircle, ChevronRight, Circle, InProgress } from "@/shared/ui/icons";
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

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  const props = { "aria-label": STATUS_LABEL[status], role: "img", className: "todo-card__status" } as const;
  return status === "completed" ? <CheckCircle {...props} /> : status === "in_progress" ? <InProgress {...props} /> : <Circle {...props} />;
}

export function TodoCard({
  todo,
  writtenAtMs,
}: {
  /** The conversation's `pinomad.todo` document, when it has a valid one. */
  todo: TodoState | undefined;
  /** When the newest run last wrote the list; absent when it never did. */
  writtenAtMs?: number;
}) {
  const items = todo?.items ?? [];
  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const allDone = completed === total;
  // Unset until the user toggles: a finished list folds by itself, but an
  // explicit choice is never overridden.
  const [userOpen, setUserOpen] = useState<boolean>();

  if (total === 0 || (writtenAtMs === undefined && allDone)) {
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
          {writtenAtMs === undefined ? null : <UpdatedAgo atMs={writtenAtMs} />}
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
