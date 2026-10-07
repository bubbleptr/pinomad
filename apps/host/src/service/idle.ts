// Restart gating (ADR-0009 §5): the task graph is every live task, so an empty
// map means idle — a pending `question.wait` counts as busy by design.
import type { TaskGraph } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";

/**
 * Resolve once the host has no live tasks, or when the connection leaves
 * `connected` — a host that went away is being restarted anyway. Fires
 * `onBusy` once with the live graph when tasks are running.
 *
 * Reads `view.tasks` to decide whether to subscribe, so it expects a fresh
 * connection where the tasks stream was never toggled.
 */
export async function waitForIdle(remote: RemoteDurable, onBusy: (tasks: TaskGraph) => void): Promise<void> {
  if (remote.view.current().tasks === undefined) await remote.controller.toggleTasks();
  let announced = false;
  await new Promise<void>((resolve) => {
    const check = (): void => {
      const view = remote.view.current();
      if (view.connection !== "connected") {
        unsubscribe();
        resolve();
        return;
      }
      const tasks = view.tasks;
      if (tasks === undefined) return;
      if (Object.keys(tasks.tasks).length === 0) {
        unsubscribe();
        resolve();
        return;
      }
      if (!announced) {
        announced = true;
        onBusy(tasks);
      }
    };
    const unsubscribe = remote.view.subscribe(check);
    check();
  });
}
