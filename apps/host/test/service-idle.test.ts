import type { TaskGraph } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { waitForIdle } from "../src/service/idle.ts";
import { connectTo, startChat, startFauxHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

describe("waitForIdle", () => {
  it("resolves immediately on an idle host", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    let busyCalls = 0;
    await waitForIdle(client, () => busyCalls++);
    expect(busyCalls).toBe(0);
  });

  it("reports the live tasks and resolves when the running turn finishes", async () => {
    // Slow enough that the turn is definitely still streaming when we look.
    const host = await startFauxHost(defer, { tokensPerSecond: 20 });
    const client = await connectTo(defer, host);
    // Subscribe the graph first so its snapshot cannot race waitForIdle's toggle.
    await client.controller.toggleTasks();
    await startChat(client, "go");
    await waitForView(client.view, (view) => Object.keys(view.tasks?.tasks ?? {}).length > 0);

    let resolved = false;
    let busy: TaskGraph | undefined;
    const idle = waitForIdle(client, (tasks) => {
      busy = tasks;
    }).then(() => {
      resolved = true;
    });
    // The graph was already non-empty at subscribe time, so onBusy ran
    // synchronously and the promise must still be pending.
    expect(Object.keys(busy?.tasks ?? {}).length).toBeGreaterThan(0);
    expect(resolved).toBe(false);

    await waitForView(client.view, (view) => view.tasks !== undefined && Object.keys(view.tasks.tasks).length === 0);
    await idle;
    expect(resolved).toBe(true);
  });
});
