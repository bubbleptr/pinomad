import type { InboxTaskState } from "@pinomad/client/inbox.ts";
import { StatusDot } from "../../shared/ui/status-dot.tsx";

/**
 * An Inbox task's state light. Decorative: the row says the state in words.
 * Queued is an empty ring (nothing has happened yet); a closed task is grey.
 */
export function TaskDot({ state }: { state: InboxTaskState }) {
  return (
    <span aria-hidden="true" data-slot="inbox-task-dot" data-state={state} className="flex size-4 shrink-0 items-center justify-center">
      {state === "pending" ? (
        <span className="inline-block size-2 rounded-full shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]" />
      ) : (
        <StatusDot
          variant={state === "waiting" ? "warning" : state === "running" ? "success" : state === "failed" ? "error" : "neutral"}
          label={state}
          pulsing={state === "running"}
          className={state === "done" || state === "skipped" ? "opacity-50" : undefined}
        />
      )}
    </span>
  );
}
